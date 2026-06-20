/**
 * Local Sandbox Manager
 *
 * Creates isolated execution environments for agent code.
 * Each session gets a fresh sandbox directory.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { AgentMemoryConfig, ExecutionResult, LoadedTool } from '../types/index.js';
import type { ISandbox } from './interfaces.js';
import {
    COMPLETION_SIGNAL_END,
    COMPLETION_SIGNAL_START,
    LEGACY_COMPLETION_FUNCTION,
    PRIMARY_COMPLETION_FUNCTION,
} from '../core/completion.js';
import { buildPowerShellCommand, normalizeCliCommand, shouldFallbackToCmd } from './windows-shell.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Path to the built-in files tool
const FILES_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'files', 'index.ts');
// Path to the built-in terminal tool
const TERMINAL_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'terminal', 'index.ts');
// Path to the built-in code tool
const CODE_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'code', 'index.ts');
// Path to the built-in agents tool
const AGENTS_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'agents', 'index.ts');
const ACTION_WORKER_JS_PATH = join(__dirname, 'action-worker.js');
const ACTION_WORKER_TS_PATH = join(__dirname, 'action-worker.ts');
const ACTION_WORKER_PATH = existsSync(ACTION_WORKER_JS_PATH) ? ACTION_WORKER_JS_PATH : ACTION_WORKER_TS_PATH;

export class LocalSandbox implements ISandbox {
    public readonly id: string;
    public readonly directory: string;
    private readonly ownsDirectory: boolean;
    private tools: LoadedTool[] = [];
    private initialized = false;
    private memoryConfig: AgentMemoryConfig | undefined;
    private actionWorker: ChildProcess | null = null;
    private actionWorkerRequestCounter = 0;
    private actionWorkerPending = new Map<string, {
        resolve: (result: ExecutionResult) => void;
        onStderr?: (data: string) => void;
        keepAlive: NodeJS.Timeout;
    }>();
    private actionWorkerQueue: Promise<void> = Promise.resolve();

    private executionCounter: number = 0; // Counter for execution files, starts at 0
    private executedFiles: Map<string, string> = new Map(); // filename -> filePath mapping for diff support

    constructor(optionsOrBaseDir?: string | { baseDir?: string; existingPath?: string }) {
        if (typeof optionsOrBaseDir === 'object' && optionsOrBaseDir.existingPath) {
            this.id = 'attached'; // Special ID for attached sandboxes
            this.directory = resolve(optionsOrBaseDir.existingPath);
            this.ownsDirectory = false;
        } else {
            const baseDir = typeof optionsOrBaseDir === 'string' ? optionsOrBaseDir : optionsOrBaseDir?.baseDir;
            this.id = randomUUID().slice(0, 8);
            this.directory = join(baseDir || join(PROJECT_ROOT, 'sandboxes'), `session-${this.id}`);
            this.ownsDirectory = true;
        }
    }

    /**
     * @param tools - Array of loaded tools to make available in the sandbox
     * @param memoryConfig - Optional memory configuration for memory tool env wiring
     */
    async initialize(tools: LoadedTool[], memoryConfig?: AgentMemoryConfig): Promise<void> {
        this.tools = tools;
        this.memoryConfig = memoryConfig;

        if (this.ownsDirectory) {
            // Create sandbox directory
            await mkdir(this.directory, { recursive: true });

            // Create package.json for npm installs
            await this.createPackageJson();

            // Create tsconfig for the sandbox
            await this.createTsConfig();
        } else {
            const info = await stat(this.directory).catch(() => null);
            if (!info) {
                throw new Error(`Attached sandbox path does not exist: ${this.directory}`);
            }
            if (!info.isDirectory()) {
                throw new Error(`Attached sandbox path must be a directory: ${this.directory}`);
            }
        }

        this.initialized = true;
    }

    public getTools(): LoadedTool[] {
        return this.tools;
    }

    async warmUp(): Promise<void> {
        if (!this.initialized || process.env.TELOS_SANDBOX_WARM_UP === 'false') {
            return;
        }
        if (process.env.TELOS_SANDBOX_PERSISTENT_ACTION_WORKER === 'false') {
            return;
        }

        const result = await this.execute('void 0;');
        if (!result.success) {
            throw new Error(result.error || result.output || 'Sandbox warm-up action failed');
        }
    }

    getDescription(): string {
        return `## Code As Action

You act through one provider tool: \`action\`. It runs TypeScript in the current workspace and returns console output. Variables do not persist between action calls; files and named terminal/agent jobs do.

Inside \`action\`, the provided packages are already in scope. Use them directly. Do not import or destructure global tools. Additional npm packages may be loaded with \`require("package")\` after installing them.

Use \`console.log(...)\` to surface observations.

## Primary Tools

Use \`files\` for workspace inspection and edits:
- \`files.search(query, options?)\` - basically grep, but better. ALWAYS USE THIS to find text in files. It skips generated/runtime directories and logs by default; use includeIgnored only when intentional.
- \`files.list(path, options?)\` lists directories.
- \`files.read(path, options?)\` reads files. Prefer \`aroundLine/context\` or \`startLine/endLine\` for large files.
- \`files.edit(path, edits)\` is the primary way to modify existing files with exact \`{ old, new }\` replacements.
- \`files.write(path, fullContents)\` creates or intentionally replaces a whole file.
For absolute paths outside the project, pass \`allowExternal: true\` in the relevant options object.

Read relevant code before editing it. Prefer \`files.edit\` over whole-file rewrites.

Use \`code\` for code structure:
- \`code.outline(path)\` returns functions, classes, and methods with line ranges.

Use \`terminal\` for execution:
- \`terminal.run(command, options?)\` runs a finite command. Pass \`allowExternal: true\` when \`cwd\` is intentionally outside the project.
- \`terminal.start(name, command, options?)\` starts a persistent named session.
- \`terminal.read(name, options?)\`, \`terminal.send(name, text)\`, \`terminal.stop(name)\`, and \`terminal.list()\` manage sessions.

Use named terminal sessions for servers, watchers, debuggers, and interactive programs. Do not use shell backgrounding for long-running work.

Every tool has \`tool.help()\`. If syntax is unclear, inspect help instead of guessing.`;
    }

    /**
     * Execute TypeScript code in the sandbox
     * Supports both regular code execution and diff-based editing
     */
    async execute(code: string, language?: string, env?: Record<string, string>, onStderr?: (data: string) => void): Promise<ExecutionResult> {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        // Check if this is a diff format
        // If language is explicitly 'diff', we require it to parse as diff
        const isDiffMode = language === 'diff';
        const diffInfo = this.parseDiff(code);

        if (diffInfo) {
            return this.applyDiff(diffInfo);
        } else if (isDiffMode) {
            // It was supposed to be a diff but failed parsing
            return {
                success: false,
                output: '',
                error: 'Failed to parse diff: Invalid format. Ensure you use standard unified diff format starting with "--- filename" and "+++ filename", followed by "@@ ... @@" blocks.',
            };
        }

        // Clean code (remove markdown blocks if model included them)
        let cleanedCode = code.trim();
        if (cleanedCode.startsWith('```')) {
            // Remove ```javascript or ```typescript or just ```
            cleanedCode = cleanedCode.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '');
        }

        // Regular execution - generate the execution file with tool imports
        const usePersistentWorker = process.env.TELOS_SANDBOX_PERSISTENT_ACTION_WORKER !== 'false';
        const fileContent = this.generateExecutionFile(cleanedCode, usePersistentWorker ? 'worker' : 'process');
        const filename = `exec_${this.executionCounter}.cts`;
        const filePath = join(this.directory, filename);
        this.executionCounter++; // Increment counter for next execution

        await writeFile(filePath, fileContent, 'utf-8');

        // Track this file for future diff edits
        this.executedFiles.set(filename, filePath);

        let result: ExecutionResult;
        try {
            result = usePersistentWorker
                ? await this.runTypeScriptInWorker(filePath, env, onStderr)
                : await this.runTypeScript(filePath, env, onStderr);
        } finally {
            this.executedFiles.delete(filename);
            await rm(filePath, { force: true }).catch(() => {
                // Ignore temp file cleanup errors.
            });
        }

        // Add filename to result
        return {
            ...result,
            filename,
        };
    }

    /**
     * Execute a CLI command in the sandbox directory
     */
    async executeCli(command: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void): Promise<ExecutionResult> {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        const processedCommand = normalizeCliCommand(command, process.platform);
        if (!processedCommand) {
            return { success: true, output: '(empty command)' };
        }

        return this.runShellCommand(processedCommand, onStdout, onStderr);
    }

    /**
     * Run a shell command in the sandbox directory
     */
    private async runShellCommand(command: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void): Promise<ExecutionResult> {
        const env: NodeJS.ProcessEnv = { ...process.env };
        this.applyMemoryEnv(env);

        if (process.platform === 'win32') {
            const psResult = await this.spawnCommand(
                'powershell',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildPowerShellCommand(command)],
                {
                    cwd: this.directory,
                    env,
                    shell: false,
                },
                onStdout,
                onStderr
            );

            if (psResult.success) {
                return this.toExecutionResult(psResult);
            }

            if (!shouldFallbackToCmd(psResult.stderr, psResult.startError)) {
                return this.toExecutionResult(psResult);
            }

            const cmdResult = await this.spawnCommand(
                'cmd.exe',
                ['/d', '/s', '/c', command],
                {
                    cwd: this.directory,
                    env,
                    shell: false,
                },
                onStdout,
                onStderr
            );

            const fallback = this.toExecutionResult(cmdResult);
            const fallbackNotice = '[windows-shell] PowerShell failed to execute this command; retried via cmd.exe.';

            if (fallback.success) {
                fallback.output = `${fallbackNotice}\n${fallback.output}`.trim();
                return fallback;
            }

            fallback.error = `${fallbackNotice}\nPowerShell error:\n${psResult.stderr || psResult.startError || psResult.error || '(no stderr)' }\n\ncmd.exe error:\n${fallback.error || '(no stderr)'}`.trim();
            return fallback;
        }

        const result = await this.spawnCommand(
            command,
            [],
            {
                cwd: this.directory,
                shell: true,
                env,
            },
            onStdout,
            onStderr
        );
        return this.toExecutionResult(result);
    }

    private spawnCommand(
        command: string,
        args: string[],
        options: {
            cwd: string;
            shell: boolean;
            env: NodeJS.ProcessEnv;
        },
        onStdout?: (data: string) => void,
        onStderr?: (data: string) => void
    ): Promise<{
        success: boolean;
        stdout: string;
        stderr: string;
        error?: string;
        startError?: string;
    }> {
        return new Promise((resolve) => {
            const stdout: string[] = [];
            const stderr: string[] = [];
            let startError: string | undefined;

            const proc = spawn(command, args, options);

            proc.stdout.on('data', (data) => {
                const str = data.toString();
                stdout.push(str);
                if (onStdout) {
                    onStdout(str);
                }
            });

            proc.stderr.on('data', (data) => {
                const str = data.toString();
                stderr.push(str);
                if (onStderr) {
                    onStderr(str);
                }
            });

            proc.on('error', (error) => {
                startError = `Failed to start process: ${error.message}`;
            });

            proc.on('close', (code) => {
                const out = stdout.join('').trim();
                const err = stderr.join('').trim();
                resolve({
                    success: code === 0 && !startError,
                    stdout: out,
                    stderr: err,
                    error: startError || undefined,
                    startError,
                });
            });
        });
    }

    private toExecutionResult(result: {
        success: boolean;
        stdout: string;
        stderr: string;
        error?: string;
        startError?: string;
    }): ExecutionResult {
        const combinedOutput = [result.stdout, result.stderr].filter(Boolean).join('\n');
        if (result.success) {
            return {
                success: true,
                output: combinedOutput || '(no output)',
            };
        }

        return {
            success: false,
            output: result.stdout,
            error: result.stderr || result.error || result.startError || 'Process exited with non-zero code',
        };
    }

    /**
     * Generate the execution file with tool imports
     */
    private generateExecutionFile(code: string, runtime: 'process' | 'worker' = 'process'): string {
        const requireStatements: string[] = [];
        const injectedToolNames: string[] = ['files', 'terminal', 'code'];

        // Always require the files tool (built-in system tool)
        const filesToolRelativePath = this.getRelativePath(FILES_TOOL_PATH);
        requireStatements.push(`const files = __telosLazyWaitableTool(() => require('${filesToolRelativePath}'), 'files', ${JSON.stringify(this.getBuiltInToolHelp('files'))});`);
        const terminalToolRelativePath = this.getRelativePath(TERMINAL_TOOL_PATH);
        requireStatements.push(`const terminal = __telosLazyWaitableTool(() => require('${terminalToolRelativePath}'), 'terminal', ${JSON.stringify(this.getBuiltInToolHelp('terminal'))});`);
        const codeToolRelativePath = this.getRelativePath(CODE_TOOL_PATH);
        requireStatements.push(`const code = __telosLazyWaitableTool(() => require('${codeToolRelativePath}'), 'code', ${JSON.stringify(this.getBuiltInToolHelp('code'))});`);

        // Add user-configured tools
        for (const tool of this.tools) {
            // Skip built-in tools if they were explicitly added in config
            if (tool.config.name === 'files' || tool.config.name === 'terminal' || tool.config.name === 'code') continue;

            const relativePath = this.getRelativePath(tool.absolutePath);
            requireStatements.push(`const ${tool.config.name} = __telosLazyWaitableTool(() => require('${relativePath}'), '${tool.config.name}', ${JSON.stringify(this.getConfiguredToolHelp(tool))});`);
            injectedToolNames.push(tool.config.name);
        }

        const toolRequires = requireStatements.join('\n');
        const toolGlobals = this.getToolGlobalsBootstrap(injectedToolNames);

        // Build the set of tool names already auto-imported so we can strip duplicates
        const autoImportedNames = new Set<string>(['files', 'terminal', 'code']);
        for (const tool of this.tools) {
            if (tool.config.name !== 'files' && tool.config.name !== 'terminal' && tool.config.name !== 'code') {
                autoImportedNames.add(tool.config.name);
            }
        }

        // Remove any require()/import lines the agent wrote for already-injected tools
        // (prevents "Cannot redeclare" errors when an agent manually imports an auto-imported tool)
        const strippedCode = this.stripDuplicateToolImports(code, autoImportedNames);

        // Extract all import/require statements from agent code and convert to require()
        const { imports: agentRequires, codeWithoutImports } = this.extractImports(strippedCode);

        // Tool requires stay at the top level (they're static relative requires)
        // Agent requires (npm packages) are converted to require() calls inside the IIFE

        // Wrap the code in an async IIFE to support top-level await
        const globalsBootstrap = this.getGlobalsBootstrap();
        const asyncToolTrackingBootstrap = this.getAsyncToolTrackingBootstrap();

        if (runtime === 'worker') {
            return `${globalsBootstrap}

${asyncToolTrackingBootstrap}
${toolRequires}
${toolGlobals}

// Agent code execution
module.exports = (async () => {
try {
// Package requires
${agentRequires}

${codeWithoutImports}
  await __telosWaitForTrackedAsyncTasks();
  const exitGraceMs = __telosReadNonNegativeIntEnv('TELOS_SANDBOX_EXIT_GRACE_MS', 0);
  if (exitGraceMs > 0) {
    await __telosSleep(exitGraceMs);
  }
} catch (err) {
  if (err && err.__telosCompletionSignal) {
    return;
  }
  if (err && err.__telosWorkerProcessExit) {
    process.exitCode = err.code ?? 0;
    return;
  }
  console.error(err);
  process.exitCode = 1;
  const errorExitGraceMs = __telosReadNonNegativeIntEnv('TELOS_SANDBOX_ERROR_EXIT_GRACE_MS', 0);
  if (errorExitGraceMs > 0) {
    await __telosSleep(errorExitGraceMs);
  }
}
})();
`;
        }

        return `${globalsBootstrap}

${asyncToolTrackingBootstrap}
${toolRequires}
${toolGlobals}

// Agent code execution
(async () => {
// Package requires
${agentRequires}

${codeWithoutImports}
})().then(async () => {
  await __telosWaitForTrackedAsyncTasks();
  const exitGraceMs = __telosReadNonNegativeIntEnv('TELOS_SANDBOX_EXIT_GRACE_MS', 0);
  if (exitGraceMs > 0) {
    await __telosSleep(exitGraceMs);
  }
}).then(() => {
  process.exit(process.exitCode ?? 0);
}).catch(async err => {
  console.error(err);
  process.exitCode = 1;
  const errorExitGraceMs = __telosReadNonNegativeIntEnv('TELOS_SANDBOX_ERROR_EXIT_GRACE_MS', 0);
  if (errorExitGraceMs > 0) {
    await __telosSleep(errorExitGraceMs);
  }
  process.exit(process.exitCode ?? 1);
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exit(1);
});
`;
    }

    private getAsyncToolTrackingBootstrap(): string {
        return `
// Tracks async tool calls that agents sometimes start without awaiting at top
// level (e.g. calling an async function but not awaiting its return promise).
// This keeps actions alive until all floating promise chains finish.
const __telosTrackedAsyncTasks = new Set();

function __telosReadNonNegativeIntEnv(name, fallbackValue) {
  const raw = process.env[name];
  if (!raw) return fallbackValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackValue;
}

function __telosSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function __telosTrackAsyncTask(value, label) {
  if (!value || typeof value.then !== 'function') {
    return value;
  }

  let tracked;
  tracked = Promise.resolve(value)
    .then(() => undefined, () => undefined)
    .finally(() => {
      __telosTrackedAsyncTasks.delete(tracked);
    });

  __telosTrackedAsyncTasks.add(tracked);
  return value;
}

function __telosBuildToolHelp(toolName, toolHelpText) {
  const text = String(toolHelpText || '').trim();
  return text || \`No documentation is available for tool "\${toolName}".\`;
}

function __telosWrapWaitableTool(tool, toolName, toolHelpText) {
  if (!tool || (typeof tool !== 'object' && typeof tool !== 'function')) {
    return tool;
  }

  return new Proxy(tool, {
    get(target, prop, receiver) {
      if (prop === 'help') {
        return function help() {
          return __telosBuildToolHelp(toolName, toolHelpText);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && typeof value === 'function') {
        return function (...args) {
          const result = Reflect.apply(value, target, args);
          if (result && typeof result.then === 'function') {
            return __telosTrackAsyncTask(result, \`\${toolName}.\${prop}\`);
          }
          return result;
        };
      }
      return value;
    },
    has(target, prop) {
      return prop === 'help' || prop in target;
    },
    ownKeys(target) {
      const keys = new Set(Reflect.ownKeys(target));
      keys.add('help');
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'help') {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: function help() {
            return __telosBuildToolHelp(toolName, toolHelpText);
          },
        };
      }
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

function __telosLazyWaitableTool(loadTool, toolName, toolHelpText) {
  let loaded = false;
  let tool;

  function getLoadedTool() {
    if (!loaded) {
      tool = __telosWrapWaitableTool(loadTool(), toolName, toolHelpText);
      loaded = true;
    }
    return tool;
  }

  return new Proxy(function __telosLazyToolProxy() {}, {
    get(_target, prop, receiver) {
      if (prop === '__telosIsLazyTool') {
        return true;
      }
      if (prop === 'help') {
        return function help() {
          return __telosBuildToolHelp(toolName, toolHelpText);
        };
      }
      return Reflect.get(getLoadedTool(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(getLoadedTool(), prop, value, receiver);
    },
    has(_target, prop) {
      return prop === 'help' || prop in getLoadedTool();
    },
    ownKeys(target) {
      const keys = new Set([...Reflect.ownKeys(target), ...Reflect.ownKeys(getLoadedTool())]);
      keys.add('help');
      return Array.from(keys);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (prop === 'help') {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: function help() {
            return __telosBuildToolHelp(toolName, toolHelpText);
          },
        };
      }
      return Reflect.getOwnPropertyDescriptor(getLoadedTool(), prop)
        || Reflect.getOwnPropertyDescriptor(target, prop);
    },
    apply(_target, thisArg, args) {
      const loadedTool = getLoadedTool();
      if (typeof loadedTool !== 'function') {
        throw new TypeError(\`Tool "\${toolName}" is not directly callable; call one of its methods instead.\`);
      }
      return Reflect.apply(loadedTool, thisArg, args);
    },
  });
}

async function __telosWaitForTrackedAsyncTasks() {
  const idleMs = __telosReadNonNegativeIntEnv('TELOS_SANDBOX_ASYNC_IDLE_MS', 0);

  for (;;) {
    if (__telosTrackedAsyncTasks.size === 0) {
      await __telosSleep(idleMs);
      if (__telosTrackedAsyncTasks.size === 0) {
        return;
      }
      continue;
    }

    await Promise.race(Array.from(__telosTrackedAsyncTasks));
  }
}
`;
    }

    private getToolGlobalsBootstrap(toolNames: string[]): string {
        const uniqueToolNames = Array.from(new Set(toolNames.filter(Boolean)));
        if (uniqueToolNames.length === 0) {
            return '';
        }

        return uniqueToolNames
            .map((toolName) => `(globalThis as any)[${JSON.stringify(toolName)}] = ${toolName};`)
            .join('\n');
    }

    private getBuiltInToolHelp(toolName: 'files' | 'terminal' | 'code'): string {
        if (toolName === 'files') {
            return [
                'Tool: files',
                'Use for filesystem work in the sandbox. Search returns an array of { path, line, preview } matches.',
                'API:',
                '- await files.read(path, { raw?, lineNumbers?, startLine?, endLine?, aroundLine?, context?, allowExternal? }?)',
                '- await files.search(query, { path?, dir?, glob?, maxResults?, includeIgnored?, previewChars?, recursive?, caseSensitive?, allowExternal? }?)',
                '- await files.list(path, { depth?, includeSizes?, maxEntries?, includeIgnored?, allowExternal? }?)',
                '- await files.write(path, fullContents, { allowExternal? }?)',
                '- await files.edit(path, [{ old, new, replaceAll?, occurrence? }], { allowExternal? }?)',
                'Pass allowExternal: true only when intentionally accessing an absolute path outside the project.',
            ].join('\n');
        }

        if (toolName === 'terminal') {
            return [
                'Tool: terminal',
                'Use for shell commands and persistent terminal sessions.',
                'API:',
                '- await terminal.run(command, { timeoutMs?, cwd?, allowExternal?, env? }?)',
                '- await terminal.start(name, command, { cwd?, allowExternal?, env?, cols?, rows? }?)',
                '- await terminal.read(name, { tail? })',
                '- await terminal.send(name, text)',
                '- await terminal.stop(name)',
                '- await terminal.list()',
            ].join('\n');
        }

        return [
            'Tool: code',
            'Use for code-aware helpers.',
            'API:',
            '- await code.outline(path)',
        ].join('\n');
    }

    private getConfiguredToolHelp(tool: LoadedTool): string {
        const description = String(tool.config.description || '').trim();
        const lines = [
            `Tool: ${tool.config.name}`,
            description || 'No description provided.',
        ];
        if (tool.config.module) {
            lines.push(`Module: ${tool.config.module}`);
        }
        return lines.join('\n');
    }

    /**
     * Extract import and require statements from code
     * Returns the requires and the code without those statements
     * Converts ESM imports to CJS require() calls
     */
    private extractImports(code: string): { imports: string; codeWithoutImports: string } {
        const lines = (code || '').split('\n');
        const lineStartsInCode = this.getLineStartsInCode(code || '');
        const requires: string[] = [];
        const codeLines: string[] = [];
        let inMultiLineImport = false;
        let currentImport = '';

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? '';
            const trimmed = line.trim();
            const startsInCode = lineStartsInCode[index] !== false;

            // Check if line starts an import statement (including 'import type')
            const isImport = trimmed.startsWith('import ') || trimmed.startsWith('import\t') || trimmed.startsWith('import{') || trimmed.startsWith('import type ');

            if (startsInCode && isImport) {
                // Check if it's a complete import (ends with semicolon or quote)
                if (trimmed.includes(';') || (trimmed.includes("'") && trimmed.split("'").length >= 3) || (trimmed.includes('"') && trimmed.split('"').length >= 3)) {
                    // Complete import on one line - convert to require()
                    const converted = this.convertToRequire(line);
                    if (converted) {
                        requires.push(converted);
                    } else {
                        requires.push(line);
                    }
                } else {
                    // Multi-line import
                    inMultiLineImport = true;
                    currentImport = line;
                }
            } else if (startsInCode && inMultiLineImport) {
                // Continue building multi-line import
                currentImport += '\n' + line;
                // Check if this line completes the import (has semicolon or closing quote)
                if (line.includes(';') || (line.includes("'") && line.split("'").length >= 3) || (line.includes('"') && line.split('"').length >= 3)) {
                    const converted = this.convertToRequire(currentImport);
                    if (converted) {
                        requires.push(converted);
                    } else {
                        requires.push(currentImport);
                    }
                    inMultiLineImport = false;
                    currentImport = '';
                }
            } else {
                // Regular code line
                codeLines.push(line);
            }
        }

        // Handle case where multi-line import wasn't closed
        if (inMultiLineImport && currentImport) {
            const converted = this.convertToRequire(currentImport);
            if (converted) {
                requires.push(converted);
            } else {
                requires.push(currentImport);
            }
        }

        return {
            imports: requires.join('\n'),
            codeWithoutImports: codeLines.join('\n'),
        };
    }

    /**
     * Remove require()/import lines from agent code that reference already auto-imported tool names.
     * Prevents "Cannot redeclare" errors when an agent manually imports a tool
     * that the sandbox already injects automatically.
     *
     * Handles these patterns where `name` is a known tool name:
     *   const/let/var name = require('...');
     *   import name from '...';
     *   import * as name from '...';
     */
    private stripDuplicateToolImports(code: string, autoImportedNames: Set<string>): string {
        const lines = (code || '').split('\n');
        const lineStartsInCode = this.getLineStartsInCode(code || '');
        const result: string[] = [];
        const aliasRewrites = new Map<string, string>();

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index] ?? '';
            const trimmed = line.trim();
            if (lineStartsInCode[index] === false) {
                result.push(line);
                continue;
            }

            // Match: const/let/var name = require('...');
            const requireMatch = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*$/);
            if (requireMatch) {
                const name = requireMatch[1];
                const moduleName = requireMatch[2];
                if (name && autoImportedNames.has(name)) {
                    // Drop the line â€” this tool is already auto-imported at the top
                    result.push(`// [auto-fix] removed duplicate require for already-injected tool: ${name}`);
                    continue;
                }
                if (name && moduleName && autoImportedNames.has(moduleName)) {
                    aliasRewrites.set(name, moduleName);
                    result.push(`// [auto-fix] removed aliased require for already-injected tool: ${name} -> ${moduleName}`);
                    continue;
                }
            }

            // Match: const { toolName } = require('...');
            const destructuredRequireMatch = trimmed.match(/^(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?\s*$/);
            if (destructuredRequireMatch) {
                const names = (destructuredRequireMatch[1] || '')
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean);
                const remaining = names.filter((name) => !autoImportedNames.has(name));
                const removed = names.filter((name) => autoImportedNames.has(name));
                if (removed.length > 0) {
                    result.push(`// [auto-fix] removed duplicate destructured require for already-injected tool(s): ${removed.join(', ')}`);
                    if (remaining.length > 0) {
                        result.push(line.replace(/\{[^}]+\}/, `{ ${remaining.join(', ')} }`));
                    }
                    continue;
                }
            }

            // Match: import name from '...' or import * as name from '...'
            const importMatch = trimmed.match(/^import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
            if (importMatch) {
                const name = importMatch[1];
                const moduleName = importMatch[2];
                if (name && autoImportedNames.has(name)) {
                    result.push(`// [auto-fix] removed duplicate import for already-injected tool: ${name}`);
                    continue;
                }
                if (name && moduleName && autoImportedNames.has(moduleName)) {
                    aliasRewrites.set(name, moduleName);
                    result.push(`// [auto-fix] removed aliased import for already-injected tool: ${name} -> ${moduleName}`);
                    continue;
                }
            }

            // Match: import { toolName } from '...';
            const namedImportMatch = trimmed.match(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/);
            if (namedImportMatch) {
                const names = (namedImportMatch[1] || '')
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean);
                const remaining = names.filter((name) => !autoImportedNames.has(name));
                const removed = names.filter((name) => autoImportedNames.has(name));
                if (removed.length > 0) {
                    result.push(`// [auto-fix] removed duplicate named import for already-injected tool(s): ${removed.join(', ')}`);
                    if (remaining.length > 0) {
                        result.push(line.replace(/\{[^}]+\}/, `{ ${remaining.join(', ')} }`));
                    }
                    continue;
                }
            }

            result.push(line);
        }

        let normalized = result.join('\n');
        for (const [alias, toolName] of aliasRewrites.entries()) {
            const pattern = new RegExp(`\\b${this.escapeRegExp(alias)}\\.`, 'g');
            normalized = normalized.replace(pattern, `${toolName}.`);
        }

        return normalized;
    }

    private getLineStartsInCode(code: string): boolean[] {
        const flags: boolean[] = [true];
        let state: 'code' | 'single' | 'double' | 'template' | 'lineComment' | 'blockComment' = 'code';
        let escaped = false;

        for (let index = 0; index < code.length; index++) {
            const char = code[index];
            const next = code[index + 1];

            if (char === '\n') {
                if (state === 'lineComment') {
                    state = 'code';
                }
                flags.push(state === 'code');
                escaped = false;
                continue;
            }

            if (state === 'lineComment') {
                continue;
            }

            if (state === 'blockComment') {
                if (char === '*' && next === '/') {
                    state = 'code';
                    index++;
                }
                continue;
            }

            if (state === 'single' || state === 'double' || state === 'template') {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if (
                    (state === 'single' && char === "'")
                    || (state === 'double' && char === '"')
                    || (state === 'template' && char === '`')
                ) {
                    state = 'code';
                }
                continue;
            }

            if (char === '/' && next === '/') {
                state = 'lineComment';
                index++;
                continue;
            }
            if (char === '/' && next === '*') {
                state = 'blockComment';
                index++;
                continue;
            }
            if (char === "'") {
                state = 'single';
                continue;
            }
            if (char === '"') {
                state = 'double';
                continue;
            }
            if (char === '`') {
                state = 'template';
            }
        }

        return flags;
    }

    /**
     * Convert a static ESM import to a CJS require() call
     * Agents can write `import X from 'pkg'` and it'll become `const X = require('pkg')`
     */
    private convertToRequire(importStatement: string): string | null {
        // Match: import DefaultExport from 'package' or import type DefaultExport from 'package'
        const defaultImportMatch = importStatement.match(/import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/);
        if (defaultImportMatch) {
            const name = defaultImportMatch[1];
            const pkg = defaultImportMatch[2];
            if (!name || !pkg) return null;
            // Skip relative imports (tool imports)
            if (pkg.startsWith('.') || pkg.startsWith('/')) {
                return null;
            }
            return `const ${name} = require('${pkg}');`;
        }

        // Match: import * as Name from 'package' or import type * as Name from 'package'
        const namespaceImportMatch = importStatement.match(/import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
        if (namespaceImportMatch) {
            const name = namespaceImportMatch[1];
            const pkg = namespaceImportMatch[2];
            if (!name || !pkg) return null;
            if (pkg.startsWith('.') || pkg.startsWith('/')) {
                return null;
            }
            return `const ${name} = require('${pkg}');`;
        }

        // Match: import { a, b } from 'package' or import type { a, b } from 'package'
        const namedImportMatch = importStatement.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
        if (namedImportMatch) {
            const names = namedImportMatch[1];
            const pkg = namedImportMatch[2];
            if (!names || !pkg) return null;
            if (pkg.startsWith('.') || pkg.startsWith('/')) {
                return null;
            }
            const cleanNames = names.split(',').map(n => n.trim()).filter(Boolean);
            return `const { ${cleanNames.join(', ')} } = require('${pkg}');`;
        }

        return null;
    }

    /**
     * Get relative path from sandbox to a file
     */
    private getRelativePath(absolutePath: string): string {
        // Convert to relative path with forward slashes
        const fromDir = this.directory;
        const toFile = absolutePath;

        // Simple relative path calculation
        // Count how many directories up from sandbox
        const sandboxParts = fromDir.split(/[/\\]/);
        const toolParts = toFile.split(/[/\\]/);

        // Find common prefix
        let commonLength = 0;
        for (let i = 0; i < Math.min(sandboxParts.length, toolParts.length); i++) {
            if (sandboxParts[i] === toolParts[i]) {
                commonLength = i + 1;
            } else {
                break;
            }
        }

        // Build relative path
        const upCount = sandboxParts.length - commonLength;
        const upPath = '../'.repeat(upCount);
        const downPath = toolParts.slice(commonLength).join('/');

        // Keep .ts extension â€” tsx handles TypeScript requires natively
        const requirePath = upPath + downPath;

        if (!requirePath) {
            return './';
        }

        if (requirePath.startsWith('../') || requirePath.startsWith('./') || requirePath.startsWith('/')) {
            return requirePath;
        }

        return `./${requirePath}`;
    }

    /**
     * Create package.json for npm installs
     */
    private async createPackageJson(): Promise<void> {
        const packageJson = {
            name: `sandbox-${this.id}`,
            version: '1.0.0',
            description: 'TELOS agent sandbox',
            private: true,
        };

        const packageJsonPath = join(this.directory, 'package.json');
        const packageJsonContent = JSON.stringify(packageJson, null, 2);

        await writeFile(packageJsonPath, packageJsonContent, 'utf-8');
    }

    /**
     * Create tsconfig.json for the sandbox
     */
    private async createTsConfig(): Promise<void> {
        const tsconfig = {
            compilerOptions: {
                target: 'ES2022',
                module: 'CommonJS',
                moduleResolution: 'Node',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                strict: false,  // Allow loose typing in agent code
                skipLibCheck: true,
            },
        };

        const tsconfigPath = join(this.directory, 'tsconfig.json');
        const tsconfigContent = JSON.stringify(tsconfig, null, 2);

        await writeFile(tsconfigPath, tsconfigContent, 'utf-8');
    }

    private getGlobalsBootstrap(): string {
        return `
import { exit } from 'process';
import fs from 'fs';
import path from 'path';

class __TelosCompletionSignal extends Error {
    __telosCompletionSignal = true;
    code: number;

    constructor(code = 0) {
        super('__TELOS_COMPLETION_SIGNAL__');
        this.code = code;
    }
}

// System function to complete the task and send the final user-facing result.
const completeTask = (message: string) => {
    console.log('${COMPLETION_SIGNAL_START}' + JSON.stringify(message) + '${COMPLETION_SIGNAL_END}');
    if ((global as any).__TELOS_ACTION_WORKER_RUNTIME__) {
        throw new __TelosCompletionSignal(0);
    }
    exit(0);
};

(global as any).${PRIMARY_COMPLETION_FUNCTION} = completeTask;
(global as any).${LEGACY_COMPLETION_FUNCTION} = completeTask;

// Convenience helper available in action snippets.
// Writes a file in sandbox scope and logs a standard confirmation line.
(global as any).edit_file = (filename: string, content: unknown) => {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        throw new Error('edit_file(filename, content): filename must be a non-empty string');
    }

    const sandboxRoot = path.resolve(process.env.SANDBOX_DIR || process.cwd());
    const targetPath = path.resolve(sandboxRoot, filename);
    const relative = path.relative(sandboxRoot, targetPath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(\`Security Error: Cannot write outside sandbox: \${filename}\`);
    }

    const normalizedContent =
        typeof content === 'string'
            ? content
            : content === undefined
                ? ''
                : (() => {
                    try {
                        return JSON.stringify(content, null, 2);
                    } catch {
                        return String(content);
                    }
                })();

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, normalizedContent, 'utf-8');
    console.log(\`File \${filename} created/updated.\`);
};

// Convenience helper to view file contents in action snippets.
// Reads a file from the sandbox and returns its content as a string.
(global as any).view_file = (filename: string): string => {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        throw new Error('view_file(filename): filename must be a non-empty string');
    }

    const sandboxRoot = path.resolve(process.env.SANDBOX_DIR || process.cwd());
    const targetPath = path.resolve(sandboxRoot, filename);
    const relative = path.relative(sandboxRoot, targetPath);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(\`Security Error: Cannot read outside sandbox: \${filename}\`);
    }

    if (!fs.existsSync(targetPath)) {
        throw new Error(\`File not found: \${filename}\`);
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
    console.log(\`File \${filename} read (\${content.length} chars).\`);
    return content;
};

// Type definition for TypeScript (doesn't affect runtime but good for documentation if we generated d.ts)
declare global {
    function ${PRIMARY_COMPLETION_FUNCTION}(message: string): void;
    function ${LEGACY_COMPLETION_FUNCTION}(message: string): void;
    function edit_file(filename: string, content: unknown): void;
    function view_file(filename: string): string;
}
`;
    }

    /**
     * Run TypeScript file using tsx
     */
    private runTypeScript(
        filePath: string,
        extraEnv?: Record<string, string>,
        onStderr?: (data: string) => void
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const stdout: string[] = [];
            const stderr: string[] = [];

            // Build environment with memory configuration and extraEnv
            const env = { ...process.env, ...extraEnv };
            this.applyMemoryEnv(env);
            // Provide sandbox directory to tools, guaranteed string
            env.SANDBOX_DIR = this.directory;
            // The agent's process.cwd() already points to sandbox dir (see cwd: this.directory below).
            // Override PROJECT_ROOT to the sandbox dir so agent code sees both env var and cwd
            // consistent with the session directory.
            env.PROJECT_ROOT = this.directory;
            // Preserve the actual project root for tools/internal code that need it.
            env.TELOS_PROJECT_ROOT = PROJECT_ROOT || process.cwd();

            // Ensure PATH is a string
            if (process.env.PATH) {
                env.PATH = process.env.PATH;
            }

            const proc = spawn(process.execPath, ['--import', 'tsx', filePath], {
                cwd: this.directory,
                shell: false,
                env: env as NodeJS.ProcessEnv, // Cast to satisfy type if needed
            });

            proc.stdout.on('data', (data) => {
                stdout.push(data.toString());
            });

            proc.stderr.on('data', (data) => {
                const str = data.toString();
                stderr.push(str);
                if (onStderr) {
                    onStderr(str);
                }
            });

            proc.on('error', (error) => {
                resolve({
                    success: false,
                    output: '',
                    error: `Failed to start process: ${error.message}`,
                });
            });

            proc.on('close', (code) => {
                const output = stdout.join('').trim();
                const errorOutput = stderr.join('').trim();

                if (code === 0) {
                    resolve({
                        success: true,
                        output: output || '(no output)',
                    });
                } else {
                    resolve({
                        success: false,
                        output,
                        error: errorOutput || `Process exited with code ${code}`,
                    });
                }
            });
        });
    }

    private runTypeScriptInWorker(
        filePath: string,
        extraEnv?: Record<string, string>,
        onStderr?: (data: string) => void
    ): Promise<ExecutionResult> {
        const run = () => this.runTypeScriptInWorkerOnce(filePath, extraEnv, onStderr)
            .catch(async (error: any) => {
                await this.stopActionWorker();
                return {
                    success: false,
                    output: '',
                    error: `Persistent action worker failed: ${error?.message || String(error)}`,
                };
            });

        const queued = this.actionWorkerQueue.then(run, run);
        this.actionWorkerQueue = queued.then(() => undefined, () => undefined);
        return queued;
    }

    private runTypeScriptInWorkerOnce(
        filePath: string,
        extraEnv?: Record<string, string>,
        onStderr?: (data: string) => void
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const worker = this.ensureActionWorker();
            const env = { ...process.env, ...extraEnv };
            this.applyMemoryEnv(env);
            env.SANDBOX_DIR = this.directory;
            env.PROJECT_ROOT = this.directory;
            env.TELOS_PROJECT_ROOT = PROJECT_ROOT || process.cwd();
            if (process.env.PATH) {
                env.PATH = process.env.PATH;
            }

            const id = String(++this.actionWorkerRequestCounter);
            const keepAlive = setInterval(() => {
                // Keeps the parent event loop alive while this unrefed worker request is pending.
            }, 1000);
            this.actionWorkerPending.set(id, { resolve, onStderr, keepAlive });
            this.refActionWorker(worker);
            worker.send?.({ type: 'run', id, filePath, env }, (error) => {
                if (!error) {
                    return;
                }
                const pending = this.actionWorkerPending.get(id);
                if (pending) {
                    clearInterval(pending.keepAlive);
                    this.actionWorkerPending.delete(id);
                }
                this.unrefActionWorkerIfIdle();
                resolve({
                    success: false,
                    output: '',
                    error: `Failed to send action to persistent worker: ${error.message}`,
                });
            });
        });
    }

    private ensureActionWorker(): ChildProcess {
        if (this.actionWorker && !this.actionWorker.killed) {
            return this.actionWorker;
        }

        const worker = spawn(process.execPath, ['--import', 'tsx', ACTION_WORKER_PATH], {
            cwd: this.directory,
            env: {
                ...process.env,
                SANDBOX_DIR: this.directory,
                PROJECT_ROOT: this.directory,
                TELOS_PROJECT_ROOT: PROJECT_ROOT || process.cwd(),
            },
            shell: false,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        this.unrefActionWorker(worker);

        worker.stderr?.on('data', (data) => {
            const str = data.toString();
            for (const pending of this.actionWorkerPending.values()) {
                pending.onStderr?.(str);
            }
        });

        worker.on('message', (message: any) => {
            if (!message || typeof message !== 'object') {
                return;
            }
            const id = String(message.id || '');
            const pending = this.actionWorkerPending.get(id);
            if (!pending) {
                return;
            }
            if (message.type === 'stderr') {
                const data = String(message.data || '');
                pending.onStderr?.(data);
                return;
            }
            if (message.type !== 'result') {
                return;
            }
            this.actionWorkerPending.delete(id);
            clearInterval(pending.keepAlive);
            this.unrefActionWorkerIfIdle();
            pending.resolve({
                success: Boolean(message.success),
                output: String(message.output || ''),
                error: message.error ? String(message.error) : undefined,
            });
        });

        worker.on('exit', (code, signal) => {
            this.actionWorker = null;
            const error = `Persistent action worker exited${code === null ? '' : ` with code ${code}`}${signal ? ` (${signal})` : ''}`;
            for (const [id, pending] of this.actionWorkerPending.entries()) {
                this.actionWorkerPending.delete(id);
                clearInterval(pending.keepAlive);
                pending.resolve({ success: false, output: '', error });
            }
        });

        worker.on('error', (error) => {
            this.actionWorker = null;
            for (const [id, pending] of this.actionWorkerPending.entries()) {
                this.actionWorkerPending.delete(id);
                clearInterval(pending.keepAlive);
                pending.resolve({ success: false, output: '', error: `Persistent action worker error: ${error.message}` });
            }
        });

        this.actionWorker = worker;
        return worker;
    }

    private refActionWorker(worker: ChildProcess = this.actionWorker as ChildProcess): void {
        worker.ref();
        worker.channel?.ref();
        (worker.stderr as any)?.ref?.();
    }

    private unrefActionWorker(worker: ChildProcess = this.actionWorker as ChildProcess): void {
        worker.unref();
        worker.channel?.unref();
        (worker.stderr as any)?.unref?.();
    }

    private unrefActionWorkerIfIdle(): void {
        if (this.actionWorker && this.actionWorkerPending.size === 0) {
            this.unrefActionWorker(this.actionWorker);
        }
    }

    private async stopActionWorker(): Promise<void> {
        const worker = this.actionWorker;
        this.actionWorker = null;
        if (!worker || worker.killed) {
            return;
        }
        await new Promise<void>((resolve) => {
            const done = () => resolve();
            this.refActionWorker(worker);
            worker.once('exit', done);
            worker.kill();
            setTimeout(done, 1000);
        });
    }

    private applyMemoryEnv(env: Record<string, string | undefined>): void {
        const cfg = this.memoryConfig;
        if (!cfg) return;

        if (cfg.table) env.MEMORY_TABLE = cfg.table;
        const mercuryProvider = cfg.mercuryProvider ?? cfg.linkerProvider;
        const mercuryModel = cfg.mercuryModel ?? cfg.linkerModel;
        const mercuryTemperature = cfg.mercuryTemperature ?? cfg.linkerTemperature;
        const mercuryMaxTokens = cfg.mercuryMaxTokens ?? cfg.linkerMaxTokens;
        const linkCandidatePoolMax = cfg.linkCandidatePoolMax ?? cfg.candidatePoolMax;
        const semanticMergeThreshold = cfg.semanticMergeThreshold ?? cfg.dedupeThreshold;

        if (mercuryProvider) env.MEMORY_MERCURY_PROVIDER = mercuryProvider;
        if (mercuryModel) env.MEMORY_MERCURY_MODEL = mercuryModel;
        if (typeof mercuryTemperature === 'number') env.MEMORY_MERCURY_TEMPERATURE = String(mercuryTemperature);
        if (typeof mercuryMaxTokens === 'number') env.MEMORY_MERCURY_MAX_TOKENS = String(mercuryMaxTokens);
        if (cfg.embeddingModel) env.MEMORY_EMBEDDING_MODEL = cfg.embeddingModel;
        if (typeof linkCandidatePoolMax === 'number') env.MEMORY_LINK_CANDIDATE_POOL_MAX = String(linkCandidatePoolMax);
        if (typeof cfg.maxAutoLinksPerFact === 'number') env.MEMORY_MAX_AUTO_LINKS_PER_FACT = String(cfg.maxAutoLinksPerFact);
        if (typeof semanticMergeThreshold === 'number') env.MEMORY_SEMANTIC_MERGE_THRESHOLD = String(semanticMergeThreshold);
        if (typeof cfg.overallEmbeddingWeight === 'number') env.MEMORY_OVERALL_EMBEDDING_WEIGHT = String(cfg.overallEmbeddingWeight);
        if (cfg.searchDefaultAggregationMode) env.MEMORY_SEARCH_DEFAULT_AGGREGATION_MODE = cfg.searchDefaultAggregationMode;
        if (cfg.searchDefaultCandidateMode) env.MEMORY_SEARCH_DEFAULT_CANDIDATE_MODE = cfg.searchDefaultCandidateMode;
        if (typeof cfg.searchDefaultTopK === 'number') env.MEMORY_SEARCH_DEFAULT_TOP_K = String(cfg.searchDefaultTopK);
        if (typeof cfg.searchDefaultThreshold === 'number') env.MEMORY_SEARCH_DEFAULT_THRESHOLD = String(cfg.searchDefaultThreshold);
        if (typeof cfg.searchDefaultRangeMin === 'number') env.MEMORY_SEARCH_DEFAULT_RANGE_MIN = String(cfg.searchDefaultRangeMin);
        if (typeof cfg.searchDefaultRangeMax === 'number') env.MEMORY_SEARCH_DEFAULT_RANGE_MAX = String(cfg.searchDefaultRangeMax);
        if (typeof cfg.searchMaxDepth === 'number') env.MEMORY_SEARCH_MAX_DEPTH = String(cfg.searchMaxDepth);
        if (typeof cfg.searchBeamWidth === 'number') env.MEMORY_SEARCH_BEAM_WIDTH = String(cfg.searchBeamWidth);
        if (typeof cfg.searchMaxChains === 'number') env.MEMORY_SEARCH_MAX_CHAINS = String(cfg.searchMaxChains);
        if (typeof cfg.queue?.spacingSeconds === 'number') env.MEMORY_QUEUE_SPACING_SECONDS = String(cfg.queue.spacingSeconds);
        if (cfg.notesSync?.enabled === false) env.MEMORY_NOTES_SYNC_ENABLED = 'false';
        if (typeof cfg.notesSync?.stableDelayMinutes === 'number') {
            env.MEMORY_NOTES_SYNC_STABLE_DELAY_MINUTES = String(cfg.notesSync.stableDelayMinutes);
        }
        if (typeof cfg.notesSync?.pollIntervalSeconds === 'number') {
            env.MEMORY_NOTES_SYNC_POLL_INTERVAL_SECONDS = String(cfg.notesSync.pollIntervalSeconds);
        }
    }

    /**
     * Detect if code is a unified diff format
     * Returns parsed diff info or null if not a diff
     */
    private parseDiff(code: string): { filename: string; hunks: DiffHunk[] } | null {
        const lines = code.split('\n');
        if (lines.length < 3) return null;

        // Check for unified diff header: --- filename and +++ filename
        const firstLine = lines[0]?.trim();
        const secondLine = lines[1]?.trim();

        if (!firstLine || !secondLine || !firstLine.startsWith('--- ') || !secondLine.startsWith('+++ ')) {
            return null;
        }

        // Extract filename (strip "--- " or "+++ " prefix)
        // TypeScript now knows firstLine and secondLine are strings after the checks above
        const oldFilename = (firstLine as string).substring(4).trim();
        const newFilename = (secondLine as string).substring(4).trim();

        // Both filenames should be the same for editing existing files
        // (we only support editing, not renaming)
        if (oldFilename !== newFilename) {
            return null;
        }

        const filename = oldFilename;

        // Parse diff hunks
        const hunks: DiffHunk[] = [];
        let i = 2; // Start after header lines

        while (i < lines.length) {
            const line = lines[i];
            if (!line) {
                i++;
                continue;
            }

            // Look for hunk header: @@ -start,count +start,count @@
            // Relaxed regex to handle LLM hallucinations (garbage text, missing trailing @@)
            // We just look for the numbers pattern: -N,N +N,N
            const hunkMatch = line.match(/[-âˆ’](\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/);
            if (hunkMatch) {
                // Determine if this looks like a hunk header (starts with @@ or similar, or just is the numbers)
                // If the line contains typical hunk numbers, we treat it as a header

                const oldStartStr = hunkMatch[1];
                const oldCountStr = hunkMatch[2];
                const newStartStr = hunkMatch[3];
                const newCountStr = hunkMatch[4];

                if (!oldStartStr || !newStartStr) {
                    i++;
                    continue;
                }

                const oldStart = parseInt(oldStartStr, 10);
                const oldCount = oldCountStr ? parseInt(oldCountStr, 10) : 1;
                const newStart = parseInt(newStartStr, 10);
                const newCount = newCountStr ? parseInt(newCountStr, 10) : 1;

                const hunk: DiffHunk = {
                    oldStart: oldStart - 1, // Convert to 0-based
                    oldCount,
                    newStart: newStart - 1, // Convert to 0-based
                    newCount,
                    lines: [],
                };

                i++; // Move past hunk header

                // Parse hunk lines
                while (i < lines.length) {
                    const hunkLine = lines[i];
                    if (!hunkLine) {
                        i++;
                        continue;
                    }

                    // Stop at next hunk header or end of diff
                    if (hunkLine.match(/^@@/)) {
                        break;
                    }

                    if (hunkLine.startsWith(' ') || hunkLine.startsWith('-') || hunkLine.startsWith('+')) {
                        hunk.lines.push(hunkLine);
                        i++;
                    } else {
                        // Empty line or context separator - skip
                        i++;
                    }
                }

                hunks.push(hunk);
            } else {
                i++;
            }
        }

        if (hunks.length === 0) {
            return null; // No valid hunks found
        }

        return { filename, hunks };
    }

    /**
     * Apply a unified diff to an existing file
     */
    private async applyDiff(diffInfo: { filename: string; hunks: DiffHunk[] }): Promise<ExecutionResult> {
        const { filename, hunks } = diffInfo;

        // Resolve file path relative to sandbox directory
        // Security check: ensure the path stays within sandbox
        const filePath = join(this.directory, filename);
        const relative = this.getRelativePath(filePath);
        if (relative.startsWith('..') && !relative.startsWith('../')) {
            // checks if it tries to go up. getRelativePath returns relative to sandbox.
            // Actually simply:
            if (!filePath.startsWith(this.directory)) {
                return {
                    success: false,
                    output: '',
                    error: `Security Error: Cannot access files outside sandbox: ${filename}`,
                };
            }
        }

        try {
            // Read the current file content
            // This implicitly checks if file exists
            const currentContent = await readFile(filePath, 'utf-8');
            const currentLines = currentContent.split('\n');

            // Apply all hunks using context-based matching
            const modifiedLines = this.applyAllHunks(currentLines, hunks);

            // Write the modified content back
            const newContent = modifiedLines.join('\n');
            await writeFile(filePath, newContent, 'utf-8');

            // If it's a typescript/javascript file, try to execute it to verify (or just because it might be the intention?)
            // The previous logic executed it.
            // The user says "edit... ANY FILE... ts, js, py, txt".
            // Running a txt file makes no sense.
            // If it is TS/JS, maybe we should run it?
            // "The diff editing should look like this... [code] ... generatePresentation().catch..."
            // The example shows code that runs.
            // But if I edit a README.md, I shouldn't run it.

            // Let's check extension.
            if (filename.endsWith('.ts') || filename.endsWith('.js')) {
                const result = await this.runTypeScript(filePath);
                return {
                    ...result,
                    filename,
                };
            }

            return {
                success: true,
                output: `File ${filename} updated successfully.`,
                filename
            };

        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return {
                    success: false,
                    output: '',
                    error: `Cannot apply diff: file "${filename}" not found in sandbox.`,
                };
            }
            return {
                success: false,
                output: '',
                error: `Failed to apply diff: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    /**
     * Apply all hunks using context-based matching instead of line numbers
     * This is more robust and handles cases where line numbers don't match
     */
    private applyAllHunks(originalLines: string[], hunks: DiffHunk[]): string[] {
        if (hunks.length === 0) {
            return [...originalLines];
        }

        // Find positions for all hunks using context matching
        const hunksWithPositions = hunks
            .map(hunk => ({
                hunk,
                matchPosition: this.findHunkPosition(originalLines, hunk),
            }))
            .filter(hp => hp.matchPosition !== null) as Array<{ hunk: DiffHunk; matchPosition: number }>;

        // Sort by position ascending so we can apply in order (top to bottom)
        // All positions are relative to the original file, so we apply in a single pass
        hunksWithPositions.sort((a, b) => a.matchPosition - b.matchPosition);

        if (hunksWithPositions.length === 0) {
            // No hunks could be matched - return original
            return [...originalLines];
        }

        const result: string[] = [];
        let originalIndex = 0;
        let hunkIndex = 0;

        while (originalIndex < originalLines.length || hunkIndex < hunksWithPositions.length) {
            const currentHunkObj = hunkIndex < hunksWithPositions.length ? hunksWithPositions[hunkIndex] : null;

            // If we have a hunk and we are at (or past) its start position
            // Note: If we are past its start position (due to previous hunk pushing index forward),
            // we should apply it immediately.
            // But we also need to respect the gap between previous hunk and this one.

            // Actually, we should copy lines until we reach the hunk's match position.
            // But if matchPosition < originalIndex (overlap?), we just apply it now.

            if (currentHunkObj) {
                // Copy lines until we reach the hunk
                while (originalIndex < currentHunkObj.matchPosition && originalIndex < originalLines.length) {
                    result.push(originalLines[originalIndex]!);
                    originalIndex++;
                }

                // Now apply the hunk "smartly"
                const hunk = currentHunkObj.hunk;

                // Smart Hunk Application Logic
                for (const hunkLine of hunk.lines) {
                    if (hunkLine.startsWith('+')) {
                        // Addition: always add
                        result.push(hunkLine.substring(1));
                    } else if (hunkLine.startsWith('-')) {
                        // Deletion: find the line to delete
                        const contentToDelete = hunkLine.substring(1).trim();
                        let foundAt = -1;

                        // Search ahead (limited range) for the line to delete
                        // This handles cases where file has extra lines inserted compared to what hunk expects
                        const searchLimit = 20; // Look ahead 20 lines
                        for (let i = 0; i < searchLimit && (originalIndex + i) < originalLines.length; i++) {
                            if (originalLines[originalIndex + i]!.trim() === contentToDelete) {
                                foundAt = originalIndex + i;
                                break;
                            }
                        }

                        if (foundAt !== -1) {
                            // Found the line!
                            // Preserve everything before it (if any)
                            while (originalIndex < foundAt) {
                                result.push(originalLines[originalIndex]!);
                                originalIndex++;
                            }
                            // Skip the deleted line
                            originalIndex++;
                        } else {
                            // Line to delete not found within range.
                            // Assume it was already deleted or LLM hallucinated it.
                            // Do not advance originalIndex.
                        }
                    } else if (hunkLine.startsWith(' ')) {
                        // Context: verify matches
                        const contentToMatch = hunkLine.substring(1).trim();
                        let foundAt = -1;

                        const searchLimit = 20;
                        for (let i = 0; i < searchLimit && (originalIndex + i) < originalLines.length; i++) {
                            if (originalLines[originalIndex + i]!.trim() === contentToMatch) {
                                foundAt = originalIndex + i;
                                break;
                            }
                        }

                        if (foundAt !== -1) {
                            // Found the context line
                            // Preserve everything before it
                            while (originalIndex < foundAt) {
                                result.push(originalLines[originalIndex]!);
                                originalIndex++;
                            }
                            // Keep the context line
                            result.push(originalLines[originalIndex]!);
                            originalIndex++;
                        } else {
                            // Context line not found.
                            // This suggests desynchronization or changed file.
                            // However, we shouldn't just skip/delete random lines.
                            // Best effort: Just add the context line from the hunk to result?
                            // Or assume it's there but we missed it?
                            // Safest: Keep original line at current index (don't consume it),
                            // but ignore this context requirement from hunk.
                            // This risks duplicating code if we simply ignore.
                            // Actually, if we can't match context, we might be in the wrong place.
                            // But since we are inside the hunk application, we proceed.
                        }
                    }
                }

                hunkIndex++;
            } else {
                // No more hunks, copy remainder
                if (originalIndex < originalLines.length) {
                    result.push(originalLines[originalIndex]!);
                    originalIndex++;
                } else {
                    break;
                }
            }
        }

        return result;
    }

    /**
     * Find the position of a hunk in the file using context line matching
     * Returns the line number where the hunk should be applied, or null if not found
     */
    private findHunkPosition(lines: string[], hunk: DiffHunk): number | null {
        // Extract context lines (lines that start with ' ' or '-')
        // These represent lines that should exist in the original file
        const contextLines: string[] = [];
        for (const hunkLine of hunk.lines) {
            if (hunkLine.startsWith(' ') || hunkLine.startsWith('-')) {
                const content = hunkLine.substring(1); // Remove prefix
                contextLines.push(content);
            }
        }

        // Case 1: No context lines (pure addition)
        if (contextLines.length === 0) {
            // If the file is empty, start at 0
            if (lines.length === 0) {
                return 0;
            }
            // If not empty, fallback to the hunk's declared start line
            // This allows adding to the top of file (oldStart=0) or appending
            return Math.min(hunk.oldStart, lines.length);
        }

        // Case 2: Try to match context
        // Try to find a sequence of matching context lines in the file
        // We need at least 2-3 matching consecutive lines to be confident
        const minContextMatch = Math.min(3, contextLines.length);

        for (let i = 0; i <= lines.length - minContextMatch; i++) {
            let matches = 0;
            let matchStart = i;

            // Check if we can match context lines starting at position i
            for (let j = 0; j < contextLines.length && (i + j) < lines.length; j++) {
                const hunkContextLine = contextLines[j];
                const fileLine = lines[i + j];

                if (hunkContextLine === undefined || fileLine === undefined) {
                    continue;
                }

                // Trim both for comparison (diff context lines may have trailing spaces)
                if (hunkContextLine.trim() === fileLine.trim()) {
                    matches++;
                } else {
                    // Allow a few mismatches, but break if too many
                    if (matches > 0 && j > matches + 2) {
                        break; // Too many mismatches
                    }
                }
            }

            // If we found a good match (at least minContextMatch lines), return the position
            if (matches >= minContextMatch) {
                return matchStart;
            }
        }

        // Try a more lenient match: look for the first unique context line
        const firstContextLine = contextLines[0];
        if (contextLines.length >= 1 && firstContextLine !== undefined) {
            const firstContext = firstContextLine.trim();
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line !== undefined && line.trim() === firstContext) {
                    // Verify we can match a few more lines after this
                    let subsequentMatches = 1;
                    for (let j = 1; j < Math.min(contextLines.length, 5) && (i + j) < lines.length; j++) {
                        const contextLine = contextLines[j];
                        const nextFileLine = lines[i + j];
                        if (contextLine !== undefined && nextFileLine !== undefined && contextLine.trim() === nextFileLine.trim()) {
                            subsequentMatches++;
                        }
                    }
                    if (subsequentMatches >= 2) {
                        return i;
                    }
                }
            }
        }

        // Case 3: Context matching failed completely
        // Fallback to hunk.oldStart logic "don't look at hunk" was user request,
        // but if context fails, we have no other clue.
        // However, we can check if oldStart seems reasonable.
        if (hunk.oldStart <= lines.length) {
            return hunk.oldStart;
        }

        return null;
    }

    /**
     * Parse Search & Replace format from edit block content
     * Format:
     * <<<< SEARCH
     * text to find
     * >>>>
     * <<<< REPLACE
     * replacement text
     * >>>>
     */
    parseSearchReplace(content: string): Array<{ search: string; replace: string }> {
        const edits: Array<{ search: string; replace: string }> = [];
        const text = content.replace(/\r\n/g, '\n');

        // Combined pattern to support both:
        // 1. Standard: <<<< SEARCH ... >>>> <<<< REPLACE ... >>>>
        // 2. Git-style: <<<< SEARCH ... ======= ... >>>>
        // Group 1: Search content
        // Group 2: Replace content
        const regex = /<<<+\s*SEARCH\s*\n([\s\S]*?)\n?(?:>>>+\s*\n<<<+\s*REPLACE|======+)\s*\n?([\s\S]*?)\n?>>>+/gi;

        let match;
        while ((match = regex.exec(text)) !== null) {
            const search = match[1] || '';
            const replace = match[2] || '';
            edits.push({ search, replace });
        }

        return edits;
    }

    /**
     * Apply Search & Replace edits to a file
     * Much simpler and more reliable than unified diff
     */
    async applySearchReplace(filename: string, edits: Array<{ search: string; replace: string }>): Promise<ExecutionResult> {
        // Resolve file path
        const filePath = join(this.directory, filename);

        // Security check
        if (!filePath.startsWith(this.directory)) {
            return {
                success: false,
                output: '',
                error: `Security Error: Cannot access files outside sandbox: ${filename}`,
            };
        }

        try {
            // Read current file
            let content = await readFile(filePath, 'utf-8');
            const appliedEdits: string[] = [];
            const errors: string[] = [];

            // Apply each edit
            for (let i = 0; i < edits.length; i++) {
                const edit = edits[i];
                if (!edit) continue;

                const { search, replace } = edit;

                // Count occurrences
                const occurrences = content.split(search).length - 1;

                if (occurrences === 0) {
                    // Not found - provide helpful error
                    const searchPreview = search.length > 100
                        ? search.substring(0, 100) + '...'
                        : search;
                    errors.push(`Edit #${i + 1}: Text not found:\n"${searchPreview}"\n\nMake sure the SEARCH text matches EXACTLY (including whitespace).`);
                } else if (occurrences > 1) {
                    // Multiple occurrences - ambiguous
                    const searchPreview = search.length > 60
                        ? search.substring(0, 60) + '...'
                        : search;
                    errors.push(`Edit #${i + 1}: Found ${occurrences} matches for:\n"${searchPreview}"\n\nAdd more context to make it unique.`);
                } else {
                    // Exactly one match - apply it
                    content = content.replace(search, replace);
                    appliedEdits.push(`Edit #${i + 1}: Applied successfully`);
                }
            }

            // Write result if any edits were applied
            if (appliedEdits.length > 0) {
                await writeFile(filePath, content, 'utf-8');
            }

            // Build result message
            const summary: string[] = [];
            if (appliedEdits.length > 0) {
                summary.push(`âœ“ Applied ${appliedEdits.length}/${edits.length} edits to ${filename}`);
            }
            if (errors.length > 0) {
                summary.push(`âœ— Failed ${errors.length}/${edits.length} edits:\n${errors.join('\n\n')}`);
            }

            // If it's a TS/JS file and all edits succeeded, run it
            if (errors.length === 0 && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
                const result = await this.runTypeScript(filePath);
                return {
                    ...result,
                    output: summary.join('\n') + '\n\n' + result.output,
                    filename,
                };
            }

            return {
                success: errors.length === 0,
                output: summary.join('\n'),
                error: errors.length > 0 ? 'Some edits failed' : undefined,
                filename,
            };

        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return {
                    success: false,
                    output: '',
                    error: `File not found: "${filename}". Create it first with a file write, or provide a creation-compatible SEARCH/REPLACE payload.`,
                };
            }
            return {
                success: false,
                output: '',
                error: `Failed to apply edits: ${error.message}`,
            };
        }
    }


    /**
     * Clean up the sandbox directory
     */
    async cleanup(): Promise<void> {
        await this.stopActionWorker();

        if (!this.ownsDirectory) {
            return;
        }

        try {
            await rm(this.directory, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

/**
 * Represents a diff hunk in unified diff format
 */
interface DiffHunk {
    oldStart: number; // 0-based line number
    oldCount: number; // Number of lines in old file
    newStart: number; // 0-based line number
    newCount: number; // Number of lines in new file
    lines: string[]; // The diff lines (with +, -, or space prefix)
}

/**
 * Represents a Search & Replace edit operation
 * Much simpler and more reliable than unified diff
 */
interface SearchReplaceEdit {
    filename: string;
    edits: Array<{
        search: string;   // Exact text to find
        replace: string;  // Text to replace with
    }>;
}

export default LocalSandbox;
