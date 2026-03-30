
import { exit } from 'process';
import fs from 'fs';
import path from 'path';

// System function to complete the task and send the final user-facing result.
const completeTask = (message: string) => {
    console.log('__ACN_TASK_DONE_START__' + JSON.stringify(message) + '__ACN_TASK_DONE_END__');
    exit(0);
};

(global as any).TASK_DONE = completeTask;
(global as any).FINISH = completeTask;

// Convenience helper available in action snippets.
// Writes a file in sandbox scope and logs a standard confirmation line.
(global as any).file = (filename: string, content: unknown) => {
    if (typeof filename !== 'string' || filename.trim().length === 0) {
        throw new Error('file(filename, content): filename must be a non-empty string');
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

// Type definition for TypeScript (doesn't affect runtime but good for documentation if we generated d.ts)
declare global {
    function TASK_DONE(message: string): void;
    function FINISH(message: string): void;
    function file(filename: string, content: unknown): void;
}
