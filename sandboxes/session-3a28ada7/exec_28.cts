
import { exit } from 'process';
import fs from 'fs';
import path from 'path';

// System function to complete the task and send the final user-facing result.
const completeTask = (message: string) => {
    console.log('__TELOS_TASK_DONE_START__' + JSON.stringify(message) + '__TELOS_TASK_DONE_END__');
    exit(0);
};

(global as any).TASK_DONE = completeTask;
(global as any).FINISH = completeTask;

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
        throw new Error(`Security Error: Cannot write outside sandbox: ${filename}`);
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
    console.log(`File ${filename} created/updated.`);
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
        throw new Error(`Security Error: Cannot read outside sandbox: ${filename}`);
    }

    if (!fs.existsSync(targetPath)) {
        throw new Error(`File not found: ${filename}`);
    }

    const content = fs.readFileSync(targetPath, 'utf-8');
    console.log(`File ${filename} read (${content.length} chars).`);
    return content;
};

// Type definition for TypeScript (doesn't affect runtime but good for documentation if we generated d.ts)
declare global {
    function TASK_DONE(message: string): void;
    function FINISH(message: string): void;
    function edit_file(filename: string, content: unknown): void;
    function view_file(filename: string): string;
}



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

function __telosWrapWaitableTool(tool, toolName) {
  if (!tool || (typeof tool !== 'object' && typeof tool !== 'function')) {
    return tool;
  }

  return new Proxy(tool, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && typeof value === 'function') {
        return function (...args) {
          const result = Reflect.apply(value, target, args);
          if (result && typeof result.then === 'function') {
            return __telosTrackAsyncTask(result, `${toolName}.${prop}`);
          }
          return result;
        };
      }
      return value;
    },
  });
}

async function __telosWaitForTrackedAsyncTasks() {
  const idleMs = __telosReadNonNegativeIntEnv('TELOS_SANDBOX_ASYNC_IDLE_MS', 50);

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

const files = __telosWrapWaitableTool(require('../../tools/files/index.ts'), 'files');
const search = __telosWrapWaitableTool(require('../../tools/search/index.ts'), 'search');
const message = __telosWrapWaitableTool(require('../../tools/message/index.ts'), 'message');
const agents = __telosWrapWaitableTool(require('../../tools/agents/index.ts'), 'agents');
const strategy = __telosWrapWaitableTool(require('../../tools/strategy/index.ts'), 'strategy');
const utils = __telosWrapWaitableTool(require('../../tools/utils/index.ts'), 'utils');
const minecraft = __telosWrapWaitableTool(require('../../tools/minecraft/index.ts'), 'minecraft');
const memory = __telosWrapWaitableTool(require('../../tools/memory/index.ts'), 'memory');
const instruction = __telosWrapWaitableTool(require('../../tools/instruction/index.ts'), 'instruction');
(globalThis as any)["files"] = files;
(globalThis as any)["search"] = search;
(globalThis as any)["message"] = message;
(globalThis as any)["agents"] = agents;
(globalThis as any)["strategy"] = strategy;
(globalThis as any)["utils"] = utils;
(globalThis as any)["minecraft"] = minecraft;
(globalThis as any)["memory"] = memory;
(globalThis as any)["instruction"] = instruction;

// Agent code execution
(async () => {
// Package requires


await instruction.next({ note: "Completed Step 6: Applied keep/kill decisions. Route state verified: parent Music Ladder (subroutesGenerated=true), children (1 kept, 3 killed). All intake + eval files written. DEPTH_PLAN.md updated with Depth 5 results." });
})().then(async () => {
  await __telosWaitForTrackedAsyncTasks();
  // Give short-lived promise chains a moment to finish, then terminate
  // explicitly so lingering keep-alive sockets do not stall the action.
  return new Promise(resolve => setTimeout(resolve, 500));
}).then(() => {
  process.exit(process.exitCode ?? 0);
}).catch(async err => {
  console.error(err);
  process.exitCode = 1;
  await new Promise(resolve => setTimeout(resolve, 200));
  process.exit(process.exitCode ?? 1);
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exit(1);
});
