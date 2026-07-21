import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ThreadStore } from './thread-store/ThreadStore.js';
import type { StoredProjectScript, StoredTerminalSession } from './thread-store/types.js';
import { TerminalService } from './TerminalService.js';

const execFileAsync = promisify(execFile);

export interface DiscoveredProjectPort {
  port: number;
  host: string;
  protocol: 'http' | 'https';
  processId?: number;
  terminalId?: string;
  url: string;
}

export class ProjectScriptService {
  constructor(
    readonly store: ThreadStore,
    readonly terminals: TerminalService,
    private readonly emit?: (threadId: string, state: string, payload: Record<string, unknown>) => void,
  ) {}

  list(projectId: string): StoredProjectScript[] {
    if (!this.store.getProject(projectId)) throw new Error(`Project not found: ${projectId}`);
    return this.store.listProjectScripts(projectId);
  }

  save(input: {
    id?: string;
    projectId: string;
    name: string;
    command: string;
    previewUrl?: string | null;
    autoOpenPreview?: boolean;
  }): StoredProjectScript {
    if (!input.name.trim() || !input.command.trim()) throw new Error('Script name and command are required.');
    if (input.previewUrl) validatePreviewUrl(input.previewUrl);
    return this.store.saveProjectScript(input);
  }

  delete(projectId: string, scriptId: string): boolean {
    return this.store.deleteProjectScript(projectId, scriptId);
  }

  async start(input: {
    threadId: string;
    scriptId: string;
    terminalId: string;
  }): Promise<{ script: StoredProjectScript; terminal: StoredTerminalSession }> {
    const thread = this.store.getThread(input.threadId);
    if (!thread) throw new Error(`Thread not found: ${input.threadId}`);
    const script = this.store.getProjectScript(input.scriptId);
    if (!script || script.projectId !== thread.projectId) {
      throw new Error(`Project script is not available to this thread: ${input.scriptId}`);
    }
    const terminal = await this.terminals.open({
      threadId: thread.id,
      terminalId: input.terminalId,
      command: script.command,
      keepOpen: true,
    });
    this.emit?.(thread.id, 'started', {
      scriptId: script.id,
      name: script.name,
      terminalId: terminal.id,
      previewUrl: script.previewUrl,
      autoOpenPreview: script.autoOpenPreview,
    });
    return { script, terminal };
  }

  async stop(threadId: string, terminalId: string): Promise<void> {
    await this.terminals.closeTerminal({ threadId, terminalId });
    this.emit?.(threadId, 'stopped', { terminalId });
  }

  async discoverPorts(threadId: string): Promise<DiscoveredProjectPort[]> {
    const terminals = this.terminals.list(threadId).filter((terminal) => terminal.pid && terminal.status === 'running');
    if (!terminals.length) return [];
    const listeners = process.platform === 'win32'
      ? await discoverWindowsListeners(terminals)
      : await discoverPosixListeners(terminals);
    const unique = new Map<number, DiscoveredProjectPort>();
    for (const listener of listeners) if (!unique.has(listener.port)) unique.set(listener.port, listener);
    const ports = [...unique.values()].sort((left, right) => left.port - right.port);
    this.emit?.(threadId, 'ports-discovered', { ports });
    return ports;
  }
}

async function discoverWindowsListeners(terminals: StoredTerminalSession[]): Promise<DiscoveredProjectPort[]> {
  const roots = new Map(terminals.flatMap((terminal) => terminal.pid ? [[terminal.pid, terminal] as const] : []));
  const descendants = new Map<number, StoredTerminalSession>(roots);
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(stdout || '[]') as
      | { ProcessId: number; ParentProcessId: number }
      | Array<{ ProcessId: number; ParentProcessId: number }>;
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of processes) {
        const owner = descendants.get(item.ParentProcessId);
        if (owner && !descendants.has(item.ProcessId)) {
          descendants.set(item.ProcessId, owner);
          changed = true;
        }
      }
    }
  } catch {
    // Direct terminal PIDs still provide useful results when CIM is unavailable.
  }
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'tcp'], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseWindowsNetstat(stdout, descendants);
}

export function parseWindowsNetstat(
  output: string,
  owners: ReadonlyMap<number, StoredTerminalSession>,
): DiscoveredProjectPort[] {
  const results: DiscoveredProjectPort[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/iu.exec(line);
    if (!match) continue;
    const pid = Number(match[3]);
    const terminal = owners.get(pid);
    if (!terminal) continue;
    results.push(portResult(Number(match[2]), match[1]!, pid, terminal.id));
  }
  return results;
}

async function discoverPosixListeners(terminals: StoredTerminalSession[]): Promise<DiscoveredProjectPort[]> {
  const owners = new Map(terminals.flatMap((terminal) => terminal.pid ? [[terminal.pid, terminal] as const] : []));
  const { stdout } = await execFileAsync('ss', ['-ltnpH'], { maxBuffer: 8 * 1024 * 1024 });
  const results: DiscoveredProjectPort[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const endpoint = line.match(/\s(\S+):(\d+)\s+\S+\s+users:/u);
    const pid = Number(line.match(/pid=(\d+)/u)?.[1]);
    const terminal = owners.get(pid);
    if (!endpoint || !terminal) continue;
    results.push(portResult(Number(endpoint[2]), endpoint[1]!, pid, terminal.id));
  }
  return results;
}

function portResult(port: number, boundHost: string, processId: number, terminalId: string): DiscoveredProjectPort {
  const host = normalizeBoundHost(boundHost);
  const protocol = port === 443 || port === 8443 ? 'https' : 'http';
  return { port, host, protocol, processId, terminalId, url: `${protocol}://${host}:${port}` };
}

function normalizeBoundHost(host: string): string {
  const value = host.replace(/^\[|\]$/gu, '');
  if (value === '0.0.0.0' || value === '::' || value === '*') return '127.0.0.1';
  return value.includes(':') ? `[${value}]` : value;
}

function validatePreviewUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Script preview URL must use HTTP or HTTPS.');
  }
}
