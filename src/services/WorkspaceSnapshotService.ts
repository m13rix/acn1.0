import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import { ThreadStore } from './thread-store/ThreadStore.js';
import type {
  WorkspaceCheckpoint,
  WorkspaceCheckpointFile,
  WorkspaceEntryKind,
} from './thread-store/types.js';

export interface WorkspaceDiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  before: WorkspaceCheckpointFile | null;
  after: WorkspaceCheckpointFile | null;
}

export interface WorkspaceDiff {
  checkpoint: WorkspaceCheckpoint;
  entries: WorkspaceDiffEntry[];
}

export interface WorkspaceRollbackResult {
  checkpoint: WorkspaceCheckpoint;
  safetyCheckpoint: WorkspaceCheckpoint;
  restoredPaths: string[];
  deletedPaths: string[];
}

interface SnapshotOptions {
  workspacePath: string;
  threadId?: string | null;
  turnId?: string | null;
  name?: string;
  ignorePatterns?: string[];
}

interface RollbackOptions {
  files?: string[];
  threadId?: string | null;
  turnId?: string | null;
  ignorePatterns?: string[];
}

interface CompiledIgnoreRule {
  negated: boolean;
  expression: RegExp;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function portablePath(path: string): string {
  return path.split(sep).join('/');
}

function depth(path: string): number {
  return path.split('/').length;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function compileIgnorePattern(rawPattern: string): CompiledIgnoreRule | null {
  let pattern = rawPattern.trim();
  if (!pattern || pattern.startsWith('#')) return null;
  const negated = pattern.startsWith('!');
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\//, '');
  if (!pattern) return null;
  const directoryOnly = pattern.endsWith('/');
  if (directoryOnly) pattern = pattern.slice(0, -1);
  const matchesAnySegment = !pattern.includes('/');
  let expression = escapeRegex(pattern)
    .replaceAll('**', '\u0000')
    .replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*')
    .replaceAll('\\?', '[^/]');
  expression = matchesAnySegment ? `(?:^|/)${expression}` : `^${expression}`;
  expression += '(?:/.*)?$';
  return { negated, expression: new RegExp(expression, 'u') };
}

function createIgnoreMatcher(patterns: string[]): (path: string) => boolean {
  const rules = patterns.map(compileIgnorePattern).filter((rule): rule is CompiledIgnoreRule => !!rule);
  return (path) => {
    let ignored = false;
    for (const rule of rules) {
      if (rule.expression.test(path)) ignored = !rule.negated;
    }
    return ignored;
  };
}

function normalizeSelection(files: string[] | undefined): string[] | null {
  if (!files?.length) return null;
  return files.map((file) => {
    const normalized = portablePath(file).replace(/^\.\//, '').replace(/\/$/, '');
    if (!normalized || isAbsolute(file) || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Invalid workspace-relative path: ${file}`);
    }
    return normalized;
  });
}

function isSelected(path: string, selection: string[] | null): boolean {
  return !selection || selection.some((selected) => path === selected || path.startsWith(`${selected}/`));
}

function entriesEqual(left: WorkspaceCheckpointFile, right: WorkspaceCheckpointFile): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'file') return left.contentHash === right.contentHash && left.mode === right.mode;
  if (left.kind === 'symlink') return left.symlinkTarget === right.symlinkTarget;
  return left.mode === right.mode;
}

export class WorkspaceSnapshotService {
  private readonly storeRoot: string;
  private readonly blobsRoot: string;
  private readonly manifestsRoot: string;

  public constructor(
    private readonly threadStore: ThreadStore,
    storeRoot: string,
  ) {
    this.storeRoot = resolve(storeRoot);
    this.blobsRoot = join(this.storeRoot, 'blobs');
    this.manifestsRoot = join(this.storeRoot, 'manifests');
  }

  public async snapshot(options: SnapshotOptions): Promise<WorkspaceCheckpoint> {
    const workspacePath = this.resolveWorkspace(options.workspacePath);
    const ignorePatterns = await this.readIgnorePatterns(workspacePath, options.ignorePatterns || []);
    const files = await this.scanWorkspace(workspacePath, ignorePatterns, true);
    const manifest = JSON.stringify(files);
    const manifestHash = sha256(manifest);
    await this.writeCasFile(join(this.manifestsRoot, `${manifestHash}.json`), Buffer.from(manifest));
    return this.threadStore.createWorkspaceCheckpoint({
      workspacePath,
      threadId: options.threadId,
      turnId: options.turnId,
      name: options.name,
      manifestHash,
      files,
    });
  }

  public listSnapshots(input: { threadId?: string; workspacePath?: string } = {}): WorkspaceCheckpoint[] {
    return this.threadStore.listCheckpoints(input);
  }

  public async diff(
    checkpointId: string,
    options: { files?: string[]; ignorePatterns?: string[] } = {},
  ): Promise<WorkspaceDiff> {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const selection = normalizeSelection(options.files);
    const ignorePatterns = await this.readIgnorePatterns(
      checkpoint.workspacePath,
      options.ignorePatterns || [],
    );
    const current = await this.scanWorkspace(checkpoint.workspacePath, ignorePatterns, false);
    const beforeByPath = new Map(
      this.threadStore
        .getCheckpointFiles(checkpointId)
        .filter((entry) => isSelected(entry.relativePath, selection))
        .map((entry) => [entry.relativePath, entry]),
    );
    const afterByPath = new Map(
      current
        .filter((entry) => isSelected(entry.relativePath, selection))
        .map((entry) => [entry.relativePath, entry]),
    );
    const paths = [...new Set([...beforeByPath.keys(), ...afterByPath.keys()])].sort();
    const entries: WorkspaceDiffEntry[] = [];
    for (const path of paths) {
      const before = beforeByPath.get(path) || null;
      const after = afterByPath.get(path) || null;
      if (before && after && entriesEqual(before, after)) continue;
      entries.push({
        path,
        status: before ? (after ? 'modified' : 'deleted') : 'added',
        before,
        after,
      });
    }
    return { checkpoint, entries };
  }

  public async rollback(checkpointId: string, options: RollbackOptions = {}): Promise<WorkspaceRollbackResult> {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const selection = normalizeSelection(options.files);
    const safetyCheckpoint = await this.snapshot({
      workspacePath: checkpoint.workspacePath,
      threadId: options.threadId ?? checkpoint.threadId,
      turnId: options.turnId ?? checkpoint.turnId,
      name: `Safety before rollback to ${checkpoint.name || checkpoint.id}`,
      ignorePatterns: options.ignorePatterns,
    });
    const targetEntries = this.threadStore
      .getCheckpointFiles(checkpointId)
      .filter((entry) => isSelected(entry.relativePath, selection));
    const ignorePatterns = await this.readIgnorePatterns(
      checkpoint.workspacePath,
      options.ignorePatterns || [],
    );
    const currentEntries = (await this.scanWorkspace(checkpoint.workspacePath, ignorePatterns, false)).filter(
      (entry) => isSelected(entry.relativePath, selection),
    );
    const targetByPath = new Map(targetEntries.map((entry) => [entry.relativePath, entry]));
    const currentByPath = new Map(currentEntries.map((entry) => [entry.relativePath, entry]));
    const deletedPaths: string[] = [];

    for (const current of [...currentEntries].sort((a, b) => depth(b.relativePath) - depth(a.relativePath))) {
      const target = targetByPath.get(current.relativePath);
      if (target?.kind === current.kind) continue;
      const absolutePath = this.resolveEntryPath(checkpoint.workspacePath, current.relativePath);
      if (current.kind === 'directory') {
        try {
          await rmdir(absolutePath);
          deletedPaths.push(current.relativePath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
        }
      } else {
        await rm(absolutePath, { force: true });
        deletedPaths.push(current.relativePath);
      }
    }

    const restoredPaths: string[] = [];
    for (const entry of targetEntries
      .filter((candidate) => candidate.kind === 'directory')
      .sort((a, b) => depth(a.relativePath) - depth(b.relativePath))) {
      const absolutePath = this.resolveEntryPath(checkpoint.workspacePath, entry.relativePath);
      await mkdir(absolutePath, { recursive: true });
      await this.restoreMetadata(absolutePath, entry);
      if (!currentByPath.has(entry.relativePath)) restoredPaths.push(entry.relativePath);
    }
    for (const entry of targetEntries.filter((candidate) => candidate.kind !== 'directory')) {
      const absolutePath = this.resolveEntryPath(checkpoint.workspacePath, entry.relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      if (entry.kind === 'symlink') {
        if (entry.symlinkTarget === null) throw new Error(`Snapshot symlink has no target: ${entry.relativePath}`);
        await rm(absolutePath, { force: true });
        await symlink(entry.symlinkTarget, absolutePath);
      } else {
        if (!entry.contentHash) throw new Error(`Snapshot file has no content hash: ${entry.relativePath}`);
        const blob = await readFile(this.blobPath(entry.contentHash));
        const temporaryPath = `${absolutePath}.telos-restore-${uuidv7()}`;
        await writeFile(temporaryPath, blob, { flag: 'wx' });
        await rm(absolutePath, { force: true });
        await rename(temporaryPath, absolutePath);
        await this.restoreMetadata(absolutePath, entry);
      }
      if (!currentByPath.has(entry.relativePath) || !entriesEqual(currentByPath.get(entry.relativePath)!, entry)) {
        restoredPaths.push(entry.relativePath);
      }
    }
    return { checkpoint, safetyCheckpoint, restoredPaths, deletedPaths };
  }

  public async deleteSnapshot(checkpointId: string): Promise<void> {
    const checkpoint = this.requireCheckpoint(checkpointId);
    const orphanedHashes = this.threadStore.deleteCheckpoint(checkpointId);
    await Promise.all(orphanedHashes.map((hash) => rm(this.blobPath(hash), { force: true })));
    if (!this.threadStore.listCheckpoints().some((item) => item.manifestHash === checkpoint.manifestHash)) {
      await rm(join(this.manifestsRoot, `${checkpoint.manifestHash}.json`), { force: true });
    }
  }

  private requireCheckpoint(checkpointId: string): WorkspaceCheckpoint {
    const checkpoint = this.threadStore.getCheckpoint(checkpointId);
    if (!checkpoint) throw new Error(`Workspace checkpoint not found: ${checkpointId}`);
    return checkpoint;
  }

  private resolveWorkspace(workspacePath: string): string {
    const workspace = resolve(workspacePath);
    const storeRelative = relative(workspace, this.storeRoot);
    if (!storeRelative || (!storeRelative.startsWith(`..${sep}`) && storeRelative !== '..' && !isAbsolute(storeRelative))) {
      throw new Error('The Telos snapshot store must be outside the workspace.');
    }
    return workspace;
  }

  private resolveEntryPath(workspacePath: string, relativePath: string): string {
    const absolutePath = resolve(workspacePath, ...relativePath.split('/'));
    const containment = relative(workspacePath, absolutePath);
    if (!containment || containment === '..' || containment.startsWith(`..${sep}`) || isAbsolute(containment)) {
      throw new Error(`Snapshot path escapes the workspace: ${relativePath}`);
    }
    return absolutePath;
  }

  private async readIgnorePatterns(workspacePath: string, configured: string[]): Promise<string[]> {
    try {
      const file = await readFile(join(workspacePath, '.telos-snapshotignore'), 'utf8');
      return [...configured, ...file.split(/\r?\n/u)];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configured;
      throw error;
    }
  }

  private async scanWorkspace(
    workspacePath: string,
    ignorePatterns: string[],
    storeBlobs: boolean,
  ): Promise<WorkspaceCheckpointFile[]> {
    await access(workspacePath, constants.R_OK);
    const ignored = createIgnoreMatcher(ignorePatterns);
    const entries: WorkspaceCheckpointFile[] = [];
    const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        if (relativePath === '.git' || relativePath.startsWith('.git/') || ignored(relativePath)) continue;
        const absolutePath = join(directory, child.name);
        const stats = await lstat(absolutePath);
        let kind: WorkspaceEntryKind;
        let contentHash: string | null = null;
        let symlinkTarget: string | null = null;
        if (stats.isSymbolicLink()) {
          kind = 'symlink';
          symlinkTarget = await readlink(absolutePath);
        } else if (stats.isDirectory()) {
          kind = 'directory';
        } else if (stats.isFile()) {
          kind = 'file';
          const bytes = await readFile(absolutePath);
          contentHash = sha256(bytes);
          if (storeBlobs) await this.writeCasFile(this.blobPath(contentHash), bytes);
        } else {
          continue;
        }
        entries.push({
          relativePath,
          contentHash,
          kind,
          size: stats.size,
          mode: stats.mode,
          symlinkTarget,
          mtimeMs: stats.mtimeMs,
        });
        if (kind === 'directory') await visit(absolutePath, relativePath);
      }
    };
    await visit(workspacePath, '');
    return entries;
  }

  private blobPath(hash: string): string {
    return join(this.blobsRoot, hash.slice(0, 2), hash);
  }

  private async writeCasFile(path: string, bytes: Uint8Array): Promise<void> {
    try {
      await access(path, constants.F_OK);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp-${uuidv7()}`;
    await writeFile(temporaryPath, bytes, { flag: 'wx' });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await rm(temporaryPath, { force: true });
    }
  }

  private async restoreMetadata(path: string, entry: WorkspaceCheckpointFile): Promise<void> {
    if (entry.mode !== null && process.platform !== 'win32') await chmod(path, entry.mode);
    if (entry.mtimeMs !== null && entry.kind !== 'symlink') {
      const modified = new Date(entry.mtimeMs);
      await utimes(path, modified, modified);
    }
  }
}
