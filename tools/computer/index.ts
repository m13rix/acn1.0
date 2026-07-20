import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open as openFile, readFile, stat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = path.join(__dirname, 'native');
const PROJECT_FILE = path.join(NATIVE_DIR, 'ComputerWorker.csproj');
const SOURCE_FILE = path.join(NATIVE_DIR, 'Program.cs');
const WORKER_DLL = path.join(NATIVE_DIR, 'bin', 'Release', 'net8.0-windows', 'Telos.ComputerWorker.dll');
const WORKER_KEY = createHash('sha256').update(path.resolve(__dirname).toLowerCase()).digest('hex').slice(0, 12);
const PIPE_NAME = `telos-computer-uia-v1-${WORKER_KEY}`;
const PIPE_PATH = `\\\\.\\pipe\\${PIPE_NAME}`;
const STATE_FILE = path.join(tmpdir(), `${PIPE_NAME}.json`);
const BUILD_LOCK = path.join(tmpdir(), `${PIPE_NAME}.build.lock`);
const DEFAULT_TIMEOUT_MS = readPositiveInt('TELOS_COMPUTER_REQUEST_TIMEOUT_MS', 30_000);

let readyPromise: Promise<void> | undefined;
let buildPromise: Promise<void> | undefined;

class ComputerCommandError extends Error {}

export interface ComputerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ComputerWindow {
  handle: string;
  ownerHandle?: string;
  zOrder: number;
  foreground: boolean;
  pid: number;
  title: string;
  processName: string;
  executablePath?: string;
  className: string;
  visible: boolean;
  minimized: boolean;
  cloaked: boolean;
  bounds: ComputerBounds;
}

export interface ComputerOpenOptions {
  waitTimeoutMs?: number;
  /** Activity lease refreshed by snapshot/actions. The visibility watchdog stops after this idle period. */
  keepVisibleMs?: number;
}

export interface ComputerWindowsOptions {
  includeHidden?: boolean;
  includeUntitled?: boolean;
  maxResults?: number;
}

export interface ComputerSnapshotOptions {
  interactiveOnly?: boolean;
  visibleOnly?: boolean;
  /** Include provider-internal Raw View nodes. Slower/noisier than the default semantic Control View. */
  rawView?: boolean;
  maxDepth?: number;
  maxElements?: number;
  /** OCR the exact window when UIA is sparse (`auto`, default), always, or never. */
  visualFallback?: 'auto' | 'always' | 'never';
}

export interface ComputerActionOptions {
  /** Explicit opt-in to global SendInput if background UIA/window-message strategies cannot work. */
  allowForegroundFallback?: boolean;
  /** Force real foreground input; also requires allowForegroundFallback. Use only after verified background failure. */
  foreground?: boolean;
}

export interface ComputerKeyOptions extends ComputerActionOptions {
  /** Target an explicit managed application instead of the most recent computer context. */
  pid?: number;
  /** Exact HWND from computer.windows(); preferred when one PID owns multiple windows. */
  window?: string;
  /** Target a specific current UIA element, usually the edit control that received setText(). */
  elementId?: string;
}

export interface ComputerClickAtOptions extends ComputerActionOptions {
  /** Target an explicit managed application instead of the most recent computer context. */
  pid?: number;
  /** Exact HWND from computer.windows(); preferred when one PID owns multiple windows. */
  window?: string;
  /** Number of clicks at the same point; use 2 for a double-click. */
  clicks?: number;
}

export interface ComputerTypeOptions extends ComputerKeyOptions {
  /** Select existing text before typing. Defaults to true. */
  replace?: boolean;
}

export interface ComputerFocusWindowOptions extends ComputerActionOptions {
  /** Actually activate the OS foreground window. Off by default to preserve user control. */
  activate?: boolean;
  keepVisibleMs?: number;
}

export interface ComputerActionResult {
  success: boolean;
  elementId: string;
  pid: number;
  strategy: string;
  backgroundSafe: boolean;
  /** The automation mechanism accepted the action; inspect UI state before claiming the app completed it. */
  effectVerified: boolean;
  warning?: string;
}

interface WorkerResponse<T> {
  id?: string;
  ok: boolean;
  result?: T;
  error?: string;
  elapsedMs?: number;
}

/**
 * Resolve an installed app name (including fuzzy/transliterated names), or attach
 * to an existing PID. The returned PID is the UIA process owning the chosen main
 * window, not necessarily the launcher process.
 */
export async function open(target: string | number, options: ComputerOpenOptions = {}): Promise<number> {
  if (typeof target !== 'string' && (!Number.isInteger(target) || target <= 0)) {
    throw new TypeError('computer.open(target): target must be a non-empty app name or positive PID.');
  }
  if (typeof target === 'string' && !target.trim()) {
    throw new TypeError('computer.open(target): app name must not be empty.');
  }
  const timeoutMs = Math.max(DEFAULT_TIMEOUT_MS, options.waitTimeoutMs ?? 15_000) + 5_000;
  return request<number>('open', { target: typeof target === 'string' ? target.trim() : target, ...options }, timeoutMs);
}

/** List visible and hidden top-level Windows app windows. */
export async function windows(options: ComputerWindowsOptions = {}): Promise<ComputerWindow[]> {
  return request<ComputerWindow[]>('windows', { ...options });
}

/** Capture a compact formatted-text UI Automation tree with stable action IDs (not a JSON object tree). */
export async function snapshot(target: number | string, options: ComputerSnapshotOptions = {}): Promise<string> {
  return request<string>('snapshot', { ...targetPayload(target, 'computer.snapshot(target)'), ...options });
}

/** Return only UIA nodes added, removed, moved, or changed since the last capture. */
export async function getChanges(target: number | string, options: ComputerSnapshotOptions = {}): Promise<string> {
  return request<string>('getChanges', { ...targetPayload(target, 'computer.getChanges(target)'), ...options });
}

/** Select one exact top-level HWND as the automation context without stealing foreground focus. */
export async function focusWindow(handle: string, options: ComputerFocusWindowOptions = {}): Promise<ComputerWindow> {
  assertWindowHandle(handle);
  if (options.activate && !options.allowForegroundFallback) {
    throw new TypeError('computer.focusWindow(..., { activate: true }) also requires allowForegroundFallback: true.');
  }
  return request<ComputerWindow>('focusWindow', { window: handle, ...options });
}

/** Activate a UIA element without global input whenever the target app permits it. */
export async function click(elementId: string, options: ComputerActionOptions = {}): Promise<ComputerActionResult> {
  assertElementId(elementId);
  return request<ComputerActionResult>('click', { elementId, ...options });
}

/** Click an exact screen coordinate inside the active/selected app without moving the shared cursor by default. */
export async function clickAt(x: number, y: number, options: ComputerClickAtOptions = {}): Promise<ComputerActionResult> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('computer.clickAt(x, y): x and y must be finite screen coordinates.');
  if (options.pid !== undefined) assertPid(options.pid);
  if (options.window !== undefined) assertWindowHandle(options.window);
  if (options.clicks !== undefined && (!Number.isInteger(options.clicks) || options.clicks < 1 || options.clicks > 3)) {
    throw new TypeError('computer.clickAt options.clicks must be an integer from 1 to 3.');
  }
  return request<ComputerActionResult>('clickAt', { x: Math.round(x), y: Math.round(y), ...options });
}

/** Replace text in an editable UIA element. */
export async function setText(elementId: string, text: string, options: ComputerActionOptions = {}): Promise<ComputerActionResult> {
  assertElementId(elementId);
  if (typeof text !== 'string') throw new TypeError('computer.setText(elementId, text): text must be a string.');
  return request<ComputerActionResult>('setText', { elementId, text, ...options });
}

/**
 * Send a named key/chord to the current managed app, e.g. Enter or Ctrl+Z.
 * Background window messages are tried first; global keyboard input remains opt-in.
 */
export async function key(keys: string, options: ComputerKeyOptions = {}): Promise<ComputerActionResult> {
  if (typeof keys !== 'string' || !keys.trim()) throw new TypeError('computer.key(keys): keys must be a non-empty key name or chord.');
  if (options.pid !== undefined) assertPid(options.pid);
  if (options.window !== undefined) assertWindowHandle(options.window);
  if (options.elementId !== undefined) assertElementId(options.elementId);
  return request<ComputerActionResult>('key', { keys: keys.trim(), ...options });
}

/** Type arbitrary Unicode text without using the user's shared keyboard by default. */
export async function type(text: string, options: ComputerTypeOptions = {}): Promise<ComputerActionResult> {
  if (typeof text !== 'string') throw new TypeError('computer.type(text): text must be a string.');
  if (options.pid !== undefined) assertPid(options.pid);
  if (options.window !== undefined) assertWindowHandle(options.window);
  if (options.elementId !== undefined) assertElementId(options.elementId);
  return request<ComputerActionResult>('type', { text, replace: options.replace ?? true, ...options });
}

/** Scroll the nearest UIA scroll container, or post a wheel message at the element center. */
export async function scroll(
  elementId: string,
  direction: 'up' | 'down',
  steps = 3,
  options: ComputerActionOptions = {},
): Promise<ComputerActionResult> {
  assertElementId(elementId);
  if (direction !== 'up' && direction !== 'down') throw new TypeError('computer.scroll direction must be "up" or "down".');
  if (!Number.isInteger(steps) || steps <= 0) throw new TypeError('computer.scroll steps must be a positive integer.');
  return request<ComputerActionResult>('scroll', { elementId, direction, steps, ...options });
}

/** Stop keeping one managed app visible, or release every active app lease. */
export async function release(pid?: number): Promise<void> {
  if (pid !== undefined) assertPid(pid);
  await request<null>('release', pid === undefined ? {} : { pid });
}

export function help(): string {
  return `Tool: computer
Native Windows UI Automation with a persistent C# worker and stable element IDs.

API:
- await computer.open(appNameOrPid, { waitTimeoutMs?, keepVisibleMs? }?) -> PID
- await computer.windows({ includeHidden?, includeUntitled?, maxResults? }?)
- await computer.snapshot(pidOrWindowHandle, { interactiveOnly?, visibleOnly?, rawView?, maxDepth?, maxElements?, visualFallback? }?) -> formatted string
- await computer.getChanges(pidOrWindowHandle, sameOptions?) -> formatted string
- await computer.focusWindow(windowHandle, { activate?: false, allowForegroundFallback? }?) -> exact window
- await computer.click(elementId, { allowForegroundFallback? }?)
- await computer.clickAt(screenX, screenY, { window?, pid?, clicks?: 1 | 2 | 3, allowForegroundFallback? }?)
- await computer.setText(elementId, text, { allowForegroundFallback? }?)
- await computer.key("Enter" | "Ctrl+Z" | other named chord, { window?, pid?, elementId?, foreground?, allowForegroundFallback? }?)
- await computer.type(text, { window?, pid?, elementId?, replace?: true, foreground?, allowForegroundFallback? }?)
- await computer.scroll(elementId, "up" | "down", steps?, { allowForegroundFallback? }?)
- await computer.release(pid?)

Defaults: snapshot uses UIA Control View, interactiveOnly=false, visibleOnly=false, maxDepth=15, maxElements=5000. visualFallback="auto" appends OCR-derived vis-* elements only when UIA is barren. rawView=true is a slower/noisier provider-debugging escape hatch.
Data shape: snapshot() and getChanges() return formatted strings, not JSON/UI-node objects. Do not use tree.children or tree.role. Print the string, or filter it with tree.split(/\\r?\\n/).filter(...), while keeping the element IDs in each line.

Action results mean the requested mechanism was accepted, not that the app completed it; effectVerified is false until verification. getChanges is scoped to the exact window handle.

Window identity: a PID can own several top-level windows. Once windows() shows multiple candidates, retain the exact handle, call snapshot(handle)/focusWindow(handle), and pass { window: handle } to key/type/clickAt.

Coordinates: visual OCR entries are directly clickable with click(visId). Use clickAt only for an unlabeled control supported by current window evidence. Background messages do not move the shared pointer; foreground input remains explicit opt-in.

Keyboard: type(text) is for arbitrary text; key("Enter") and key("Ctrl+Z") are for keys/chords. Both target the selected exact window and its remembered focused child without using the shared keyboard. Do not emit text one key call at a time and do not use terminal SendKeys. Verify the resulting state. Global SendInput remains allowForegroundFallback=true only.

Input policy: UIA control patterns are tried first, followed by targeted window messages. These do not move the user's pointer or type into the user's foreground app. Windows has no supported independent second cursor for arbitrary desktop software. Global SendInput requires allowForegroundFallback=true; force it only after verified background failure with foreground=true. It can briefly take foreground pointer/keyboard control and remains subject to UIPI.

Visibility lease: open(), snapshot(), and actions refresh a short keep-visible lease. During that active interval the worker restores the app without activation if another process minimizes or hides it. release() ends the lease immediately.`;
}

async function request<T>(command: string, payload: Record<string, unknown>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  requireWindows();
  await ensureWorker();
  try {
    return await sendRequest<T>(command, payload, timeoutMs);
  } catch (error) {
    if (error instanceof ComputerCommandError) throw error;
    // A provider can hang inside UIA. Kill/restart the isolated daemon once so
    // future actions are not permanently wedged by that provider.
    await restartWorker();
    return sendRequest<T>(command, payload, timeoutMs).catch(secondError => {
      const firstMessage = error instanceof Error ? error.message : String(error);
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`computer.${command} failed after restarting the UIA worker: ${secondMessage} (first attempt: ${firstMessage})`);
    });
  }
}

async function ensureWorker(): Promise<void> {
  const binaryWasCurrent = await workerIsCurrent();
  if (!binaryWasCurrent) {
    const stalePid = await readWorkerPid();
    if (stalePid) {
      await stopWorker(stalePid);
      try { await unlink(STATE_FILE); } catch { }
      await waitForProcessExit(stalePid, 5_000);
    }
  }
  await ensureBuilt();
  if (await probeWorker(200)) return;
  if (!readyPromise) {
    readyPromise = (async () => {
      if (await probeWorker(200)) return;
      const host = process.env.DOTNET_HOST_PATH || 'dotnet';
      const ps = `Start-Process -FilePath ${quotePowerShell(host)} -ArgumentList @(${[
        WORKER_DLL, '--pipe', PIPE_NAME, '--state', STATE_FILE,
      ].map(quotePowerShell).join(',')}) -WorkingDirectory ${quotePowerShell(NATIVE_DIR)} -WindowStyle Hidden`;
      await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], {
        windowsHide: true,
        timeout: 15_000,
      });

      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await probeWorker(250)) return;
        await delay(75);
      }
      throw new Error('Timed out starting the native UI Automation worker.');
    })().finally(() => {
      readyPromise = undefined;
    });
  }
  await readyPromise;
}

async function restartWorker(): Promise<void> {
  const pid = await readWorkerPid();
  if (pid) {
    await stopWorker(pid);
    await waitForProcessExit(pid, 5_000);
  }
  try { await unlink(STATE_FILE); } catch { }
  readyPromise = undefined;
  await delay(100);
  await ensureWorker();
}

async function ensureBuilt(): Promise<void> {
  if (await workerIsCurrent()) return;
  if (!buildPromise) {
    buildPromise = withBuildLock(async () => {
      if (await workerIsCurrent()) return;
      try {
        await execFileAsync(process.env.DOTNET_HOST_PATH || 'dotnet', [
          'build', PROJECT_FILE, '-c', 'Release', '--nologo', '--verbosity', 'minimal',
        ], {
          cwd: NATIVE_DIR,
          windowsHide: true,
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' },
        });
      } catch (error: any) {
        const details = String(error?.stderr || error?.stdout || error?.message || error).trim();
        throw new Error(`Failed to build tools/computer native worker. .NET 8 SDK is required. ${details}`);
      }
    }).finally(() => {
      buildPromise = undefined;
    });
  }
  await buildPromise;
}

async function withBuildLock<T>(work: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const handle = await openFile(BUILD_LOCK, 'wx');
      try {
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        return await work();
      } finally {
        await handle.close();
        try { await unlink(BUILD_LOCK); } catch { }
      }
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const info = await stat(BUILD_LOCK);
        if (Date.now() - info.mtimeMs > 120_000) {
          await unlink(BUILD_LOCK);
          continue;
        }
      } catch { }
      if (await workerIsCurrent()) return work();
      if (Date.now() >= deadline) throw new Error('Timed out waiting for another computer worker build to finish.');
      await delay(150);
    }
  }
}

async function workerIsCurrent(): Promise<boolean> {
  try {
    const [dll, source, project] = await Promise.all([stat(WORKER_DLL), stat(SOURCE_FILE), stat(PROJECT_FILE)]);
    return dll.mtimeMs >= Math.max(source.mtimeMs, project.mtimeMs);
  } catch {
    return false;
  }
}

async function probeWorker(timeoutMs: number): Promise<boolean> {
  try {
    await sendRequest('ping', {}, timeoutMs, false);
    return true;
  } catch {
    return false;
  }
}

function sendRequest<T>(
  command: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  includeHelpfulError = true,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = randomUUID();
    const socket = connect(PIPE_PATH);
    socket.setEncoding('utf8');
    let settled = false;
    let buffer = '';
    const timer = setTimeout(() => finish(new Error(`Native UIA request timed out after ${timeoutMs} ms.`)), timeoutMs);

    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };

    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    });
    socket.on('data', chunk => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const response = JSON.parse(line) as WorkerResponse<T>;
        if (!response.ok) {
          const prefix = includeHelpfulError ? `computer.${command}: ` : '';
          finish(new ComputerCommandError(`${prefix}${response.error || 'Native worker returned an unknown error.'}`));
          return;
        }
        finish(undefined, response.result as T);
      } catch (error) {
        finish(new Error(`Invalid response from native UIA worker: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => {
      if (!settled) finish(new Error('Native UIA worker closed the pipe without a response.'));
    });
  });
}

async function readWorkerPid(): Promise<number | undefined> {
  try {
    const value = JSON.parse(await readFile(STATE_FILE, 'utf8')) as { pid?: unknown };
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : undefined;
  } catch {
    return undefined;
  }
}

function requireWindows(): void {
  if (process.platform !== 'win32') throw new Error('The computer tool requires Windows and Microsoft UI Automation.');
}

function assertPid(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('PID must be a positive integer.');
}

function assertWindowHandle(handle: string): void {
  if (typeof handle !== 'string' || !/^0x[0-9a-f]+$/i.test(handle.trim())) {
    throw new TypeError('Window handle must be a hexadecimal HWND such as "0x13052E" from computer.windows().');
  }
}

function targetPayload(target: number | string, label: string): { pid: number } | { window: string } {
  if (typeof target === 'number') {
    assertPid(target);
    return { pid: target };
  }
  if (typeof target === 'string') {
    assertWindowHandle(target);
    return { window: target.trim() };
  }
  throw new TypeError(`${label}: target must be a PID or hexadecimal window handle from computer.windows().`);
}

function assertElementId(elementId: string): void {
  if (typeof elementId !== 'string' || !elementId.trim()) throw new TypeError('elementId must be a non-empty string from computer.snapshot().');
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return;
    }
  }
}

async function stopWorker(pid: number): Promise<void> {
  // A crashed daemon can leave a stale state file whose PID has since been
  // reused. Verify both worker-specific command-line markers before killing.
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction SilentlyContinue`,
    'if (-not $p) { exit 0 }',
    '$cmd = [string]$p.CommandLine',
    'if ($cmd.Contains($env:TELOS_EXPECTED_WORKER_DLL) -and $cmd.Contains($env:TELOS_EXPECTED_WORKER_PIPE)) {',
    `  Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    '}',
  ].join('\n');
  try {
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        TELOS_EXPECTED_WORKER_DLL: WORKER_DLL,
        TELOS_EXPECTED_WORKER_PIPE: PIPE_NAME,
      },
    });
  } catch { }
}

export default {
  open,
  windows,
  snapshot,
  getChanges,
  focusWindow,
  click,
  clickAt,
  setText,
  key,
  type,
  scroll,
  release,
  help,
};
