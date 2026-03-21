import { readdir, rm } from 'fs/promises';
import { isAbsolute, join, resolve } from 'path';
import type {
  GeneratedDocBundle,
  ImportedIntegrationKind,
  ImportedIntegrationManifest,
  ImportedKnowledgeMode,
  ImportedRuntimeLock,
  ImportInspectionDraft,
  ImportedSource,
} from '../types/index.js';
import {
  IMPORTED_TOOLS_CLAWHUB_DIR,
  IMPORTED_TOOLS_MCP_DIR,
  IMPORTED_TOOLS_RUNTIME_DIR,
} from './constants.js';
import { inspectClawhubImport } from './clawhub.js';
import { generateImportedDocs } from './docGeneration.js';
import { writeGeneratedTool } from './generator.js';
import { buildMcpSmokeInput, inspectMcpImport } from './mcp.js';
import { generateImportedSkills } from './skillGeneration.js';
import { copySourceSnapshot, inferDisplayName, resolveImportedSource } from './sourceResolver.js';
import { ensureDir, fileExists, isoNow, readJson, sha256, writeJson } from './utils.js';

interface InspectPayload {
  kind: ImportedIntegrationKind;
  source?: ImportedSource;
  docs?: Array<{ name: string; content: string }>;
  packageName?: string;
  displayName?: string;
  name?: string;
  readmeText?: string;
  readme?: string;
  knowledgeMode?: ImportedKnowledgeMode;
}

interface NormalizedInspectPayload {
  kind: ImportedIntegrationKind;
  source: ImportedSource;
  docs: Array<{ name: string; content: string }>;
  knowledgeMode: ImportedKnowledgeMode;
}

function toolBaseDir(kind: ImportedIntegrationKind): string {
  return kind === 'mcp' ? IMPORTED_TOOLS_MCP_DIR : IMPORTED_TOOLS_CLAWHUB_DIR;
}

function manifestPath(kind: ImportedIntegrationKind, slug: string): string {
  return join(toolBaseDir(kind), slug, 'import.manifest.json');
}

async function existingToolNames(): Promise<string[]> {
  const result: string[] = [];
  for (const root of [IMPORTED_TOOLS_MCP_DIR, IMPORTED_TOOLS_CLAWHUB_DIR]) {
    if (!await fileExists(root)) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        result.push(entry.name);
      }
    }
  }
  return result;
}

async function buildDocs(draft: ImportInspectionDraft, docs: Array<{ name: string; content: string }> = []): Promise<GeneratedDocBundle> {
  const sources = [
    ...(draft.original.readme ? [{ name: 'README.md', content: draft.original.readme, kind: 'readme' as const }] : []),
    ...(draft.original.skill ? [{ name: 'SKILL.md', content: draft.original.skill, kind: 'skill' as const }] : []),
    ...docs.map((doc) => ({ ...doc, kind: 'user' as const })),
    {
      name: 'inspection',
      content: JSON.stringify({ methods: draft.methods, risk: draft.risk, description: draft.description }, null, 2),
      kind: 'inspection' as const,
    },
  ];
  return generateImportedDocs(draft, sources);
}

async function buildSkills(draft: ImportInspectionDraft, docs: Array<{ name: string; content: string }> = []) {
  const sources = [
    ...(draft.original.readme ? [{ name: 'README.md', content: draft.original.readme, kind: 'readme' as const }] : []),
    ...(draft.original.skill ? [{ name: 'SKILL.md', content: draft.original.skill, kind: 'skill' as const }] : []),
    ...docs.map((doc) => ({ ...doc, kind: 'user' as const })),
    {
      name: 'inspection',
      content: JSON.stringify({ methods: draft.methods, risk: draft.risk, description: draft.description }, null, 2),
      kind: 'inspection' as const,
    },
  ];
  return generateImportedSkills(draft, sources);
}

function normalizeDocs(payload: InspectPayload): Array<{ name: string; content: string }> {
  const docs = (payload.docs || [])
    .filter((doc) => typeof doc?.content === 'string' && doc.content.trim())
    .map((doc) => ({
      name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : 'notes.md',
      content: doc.content.trim(),
    }));

  const readmeText = typeof payload.readmeText === 'string' && payload.readmeText.trim()
    ? payload.readmeText.trim()
    : typeof payload.readme === 'string' && payload.readme.trim()
      ? payload.readme.trim()
      : '';

  if (readmeText) {
    docs.unshift({ name: 'README.md', content: readmeText });
  }

  return docs;
}

export function normalizeInspectPayload(payload: InspectPayload): NormalizedInspectPayload {
  const displayName = payload.displayName?.trim() || payload.name?.trim() || payload.source?.displayName?.trim();
  const docs = normalizeDocs(payload);
  const knowledgeMode = payload.knowledgeMode || 'both';

  if (payload.source) {
    return {
      kind: payload.kind,
      source: {
        ...payload.source,
        displayName,
      },
      docs,
      knowledgeMode,
    };
  }

  if (payload.kind === 'mcp' && payload.packageName?.trim()) {
    const packageName = payload.packageName.trim();
    return {
      kind: payload.kind,
      source: {
        type: 'package',
        value: packageName,
        displayName,
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['-y', packageName],
      },
      docs,
      knowledgeMode,
    };
  }

  throw new Error('Import source is required. For MCP quick import, provide an npm package name.');
}

async function installRuntime(source: ImportedSource, runtimeDir: string): Promise<ImportedRuntimeLock> {
  const resolved = await resolveImportedSource(source);
  try {
    const runtimeSnapshotDir = join(runtimeDir, 'runtime');
    const sourceSnapshotDir = join(runtimeDir, 'source');
    await ensureDir(runtimeDir);
    await rm(runtimeSnapshotDir, { recursive: true, force: true });
    await rm(sourceSnapshotDir, { recursive: true, force: true });
    await copySourceSnapshot(resolved.runtime.runtimeDir, runtimeSnapshotDir);
    await copySourceSnapshot(resolved.sourceRoot, sourceSnapshotDir);

    const shouldRemapExecutable = source.type !== 'localPath' || Boolean(resolved.packageJson);
    const remapPath = (value: string | undefined): string | undefined => {
      if (!value) return value;
      if (!shouldRemapExecutable) return value;
      if (!isAbsolute(value)) return value;
      const runtimeRoot = resolve(resolved.runtime.runtimeDir);
      const sourceRoot = resolve(resolved.sourceRoot);
      if (resolve(value).startsWith(runtimeRoot)) {
        return resolve(runtimeSnapshotDir, value.slice(runtimeRoot.length).replace(/^[/\\]+/, ''));
      }
      if (resolve(value).startsWith(sourceRoot)) {
        return resolve(sourceSnapshotDir, value.slice(sourceRoot.length).replace(/^[/\\]+/, ''));
      }
      return value;
    };

    const lock: ImportedRuntimeLock = {
      ...resolved.runtime,
      runtimeDir: runtimeSnapshotDir,
      command: remapPath(resolved.runtime.command) || resolved.runtime.command,
      args: resolved.runtime.args.map((arg) => remapPath(arg) || arg),
      cwd: remapPath(resolved.runtime.cwd),
      version: resolved.runtime.sourceDigest.slice(0, 12),
      installedAt: isoNow(),
    };
    await writeJson(join(runtimeDir, 'install.lock.json'), lock);
    return lock;
  } finally {
    await resolved.cleanup().catch(() => {});
  }
}

async function smokeTest(manifest: ImportedIntegrationManifest): Promise<ImportedIntegrationManifest['smokeTest']> {
  const ranAt = isoNow();
  const runtime = await import('./runtime.js');
  const candidate = manifest.methods[0];
  if (!candidate) {
    return { passed: false, ranAt, outputPreview: 'No imported methods were available.' };
  }
  const input = manifest.kind === 'mcp' ? buildMcpSmokeInput(candidate) : {};
  try {
    const output = await runtime.invokeImportedMethod(
      resolve(join(manifest.directory, 'import.manifest.json')),
      candidate.methodName,
      input
    );
    return {
      passed: true,
      ranAt,
      methodName: candidate.methodName,
      outputPreview: typeof output === 'string' ? output.slice(0, 200) : JSON.stringify(output).slice(0, 200),
    };
  } finally {
    await runtime.disposeImportedRuntime(manifest.id);
  }
}

export class ImportedToolsService {
  async inspect(payload: InspectPayload): Promise<ImportInspectionDraft> {
    const normalized = normalizeInspectPayload(payload);
    const names = await existingToolNames();
    const draft = normalized.kind === 'mcp'
      ? await inspectMcpImport({ source: normalized.source, existingToolNames: names })
      : await inspectClawhubImport({ source: normalized.source, existingToolNames: names });
    draft.knowledgeMode = normalized.knowledgeMode;
    draft.docs = await buildDocs(draft, normalized.docs);
    if (normalized.knowledgeMode === 'skills' || normalized.knowledgeMode === 'both') {
      draft.skills = await buildSkills(draft, normalized.docs);
    }
    draft.description = draft.docs.toolDescription.split('\n')[0] || draft.description;
    return draft;
  }

  async apply(draft: ImportInspectionDraft): Promise<ImportedIntegrationManifest> {
    if (draft.risk.blockers.length > 0) {
      throw new Error(`Cannot apply import with blockers: ${draft.risk.blockers.join(' | ')}`);
    }

    const toolDir = join(toolBaseDir(draft.kind), draft.slug);
    const runtimeDir = join(IMPORTED_TOOLS_RUNTIME_DIR, draft.slug, sha256(JSON.stringify(draft.source)).slice(0, 12));
    const runtime = await installRuntime(draft.source, runtimeDir);
    const now = isoNow();
    const finalizedDraft: ImportInspectionDraft = {
      ...draft,
      docs: draft.knowledgeMode === 'skills'
        ? draft.docs
        : await generateImportedDocs(draft, [
          ...(draft.original.readme ? [{ name: 'README.md', content: draft.original.readme, kind: 'readme' as const }] : []),
          ...(draft.original.skill ? [{ name: 'SKILL.md', content: draft.original.skill, kind: 'skill' as const }] : []),
          {
            name: 'inspection',
            content: JSON.stringify({ methods: draft.methods, risk: draft.risk, description: draft.description }, null, 2),
            kind: 'inspection' as const,
          },
        ], { preferModel: true }),
      skills: draft.knowledgeMode === 'description'
        ? undefined
        : await generateImportedSkills(draft, [
          ...(draft.original.readme ? [{ name: 'README.md', content: draft.original.readme, kind: 'readme' as const }] : []),
          ...(draft.original.skill ? [{ name: 'SKILL.md', content: draft.original.skill, kind: 'skill' as const }] : []),
          {
            name: 'inspection',
            content: JSON.stringify({ methods: draft.methods, risk: draft.risk, description: draft.description }, null, 2),
            kind: 'inspection' as const,
          },
        ], { preferModel: true }),
    };

    const manifest: ImportedIntegrationManifest = {
      id: `${finalizedDraft.kind}:${finalizedDraft.slug}`,
      kind: finalizedDraft.kind,
      name: finalizedDraft.namespace,
      slug: finalizedDraft.slug,
      namespace: finalizedDraft.namespace,
      displayName: finalizedDraft.displayName || inferDisplayName(finalizedDraft.source),
      knowledgeMode: finalizedDraft.knowledgeMode,
      description: finalizedDraft.docs.toolDescription,
      directory: toolDir,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      source: finalizedDraft.source,
      runtime,
      methods: finalizedDraft.methods,
      risk: finalizedDraft.risk,
      docs: finalizedDraft.docs,
      skills: finalizedDraft.skills,
      original: finalizedDraft.original,
      smokeTest: { passed: false, ranAt: now, outputPreview: 'Pending smoke test.' },
    };

    await writeGeneratedTool(manifest, toolDir);
    const smoke = await smokeTest(manifest);
    if (!smoke.passed) {
      await rm(toolDir, { recursive: true, force: true });
      throw new Error(smoke.outputPreview || 'Smoke test failed.');
    }
    manifest.smokeTest = smoke;
    manifest.updatedAt = isoNow();
    await writeGeneratedTool(manifest, toolDir);
    return manifest;
  }

  async listInstalled(): Promise<ImportedIntegrationManifest[]> {
    const result: ImportedIntegrationManifest[] = [];
    for (const kind of ['mcp', 'clawhub'] as const) {
      const baseDir = toolBaseDir(kind);
      if (!await fileExists(baseDir)) continue;
      const entries = await readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const filePath = manifestPath(kind, entry.name);
        if (await fileExists(filePath)) {
          result.push(await readJson<ImportedIntegrationManifest>(filePath));
        }
      }
    }
    return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getInstalled(id: string): Promise<ImportedIntegrationManifest> {
    const installed = await this.listInstalled();
    const match = installed.find((entry) => entry.id === id);
    if (!match) {
      throw new Error(`Imported tool "${id}" was not found.`);
    }
    return match;
  }

  async reinstall(id: string): Promise<ImportedIntegrationManifest> {
    const manifest = await this.getInstalled(id);
    const draft = await this.inspect({
      kind: manifest.kind,
      source: manifest.source,
      knowledgeMode: manifest.knowledgeMode,
    });
    return this.apply(draft);
  }

  async refresh(id: string): Promise<ImportInspectionDraft> {
    const manifest = await this.getInstalled(id);
    return this.inspect({
      kind: manifest.kind,
      source: manifest.source,
      knowledgeMode: manifest.knowledgeMode,
    });
  }

  async delete(id: string): Promise<void> {
    const manifest = await this.getInstalled(id);
    const runtime = await import('./runtime.js');
    await runtime.disposeImportedRuntime(manifest.id);
    await rm(manifest.directory, { recursive: true, force: true });
    await rm(manifest.runtime.runtimeDir, { recursive: true, force: true });
  }
}

export default ImportedToolsService;
