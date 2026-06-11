
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
    console.log('__TELOS_TASK_DONE_START__' + JSON.stringify(message) + '__TELOS_TASK_DONE_END__');
    if ((global as any).__TELOS_ACTION_WORKER_RUNTIME__) {
        throw new __TelosCompletionSignal(0);
    }
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

function __telosLazyWaitableTool(loadTool, toolName) {
  let loaded = false;
  let tool;

  function getLoadedTool() {
    if (!loaded) {
      tool = __telosWrapWaitableTool(loadTool(), toolName);
      loaded = true;
    }
    return tool;
  }

  return new Proxy(function __telosLazyToolProxy() {}, {
    get(_target, prop, receiver) {
      if (prop === '__telosIsLazyTool') {
        return true;
      }
      return Reflect.get(getLoadedTool(), prop, receiver);
    },
    set(_target, prop, value, receiver) {
      return Reflect.set(getLoadedTool(), prop, value, receiver);
    },
    has(_target, prop) {
      return prop in getLoadedTool();
    },
    ownKeys() {
      return Reflect.ownKeys(getLoadedTool());
    },
    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(getLoadedTool(), prop);
    },
    apply(_target, thisArg, args) {
      const loadedTool = getLoadedTool();
      if (typeof loadedTool !== 'function') {
        throw new TypeError(`Tool "${toolName}" is not directly callable; call one of its methods instead.`);
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

const files = __telosLazyWaitableTool(() => require('../../tools/files/index.ts'), 'files');
const search = __telosLazyWaitableTool(() => require('../../tools/search/index.ts'), 'search');
const message = __telosLazyWaitableTool(() => require('../../tools/message/index.ts'), 'message');
(globalThis as any)["files"] = files;
(globalThis as any)["search"] = search;
(globalThis as any)["message"] = message;

// Agent code execution
module.exports = (async () => {
try {
// Package requires


console.log(2+2)
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
