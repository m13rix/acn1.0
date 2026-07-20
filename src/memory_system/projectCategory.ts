import { execFileSync } from 'node:child_process';
import path from 'node:path';

export type ProjectCategoryConfig = boolean | string | undefined;

export interface ProjectCategoryOptions {
  projectRoot?: string;
  gitRemoteUrl?: string | null;
}

function normalizeCategory(value: string): string | undefined {
  const trimmed = value.trim().toLocaleLowerCase();
  return trimmed || undefined;
}

function stripGitSuffix(value: string): string {
  return value.replace(/\/+$/, '').replace(/\.git$/i, '');
}

export function projectCategoryFromRemote(remoteUrl: string): string | undefined {
  const raw = remoteUrl.trim();
  if (!raw) return undefined;

  const scpLike = raw.match(/^git@([^:]+):(.+)$/i);
  if (scpLike?.[1] && scpLike[2]) {
    const repoPath = stripGitSuffix(scpLike[2].replace(/^\/+/, ''));
    return normalizeCategory(`project:${scpLike[1]}/${repoPath}`);
  }

  try {
    const parsed = new URL(raw);
    if (!parsed.hostname) return undefined;
    const repoPath = stripGitSuffix(parsed.pathname.replace(/^\/+/, ''));
    if (!repoPath) return undefined;
    return normalizeCategory(`project:${parsed.hostname}/${repoPath}`);
  } catch {
    return undefined;
  }
}

function readOriginRemote(projectRoot: string): string | undefined {
  try {
    return execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function projectCategoryFromPath(projectRoot: string): string | undefined {
  const baseName = path.basename(path.resolve(projectRoot)).trim();
  return baseName ? normalizeCategory(`project:${baseName}`) : undefined;
}

export function resolveProjectMemoryCategory(
  config: ProjectCategoryConfig,
  options: ProjectCategoryOptions = {},
): string | undefined {
  if (typeof config === 'string') {
    return normalizeCategory(config);
  }
  if (config !== true) {
    return undefined;
  }

  const projectRoot = options.projectRoot
    || process.env.TELOS_PROJECT_ROOT
    || process.env.PROJECT_ROOT
    || process.cwd();
  const remote = options.gitRemoteUrl !== undefined
    ? options.gitRemoteUrl ?? undefined
    : readOriginRemote(projectRoot);

  return (remote ? projectCategoryFromRemote(remote) : undefined)
    || projectCategoryFromPath(projectRoot);
}
