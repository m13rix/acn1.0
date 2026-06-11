/**
 * Sandbox exports
 */

export * from './interfaces.js';
export { LocalSandbox } from './LocalSandbox.js';
export { BrowserSandbox } from './BrowserSandbox.js';

import { LocalSandbox } from './LocalSandbox.js';
import { BrowserSandbox } from './BrowserSandbox.js';
import type { ISandbox } from './interfaces.js';

export interface SandboxCreateOptions {
    baseDir?: string;
    existingPath?: string;
}

export function createSandbox(type: string = 'local', options?: SandboxCreateOptions): ISandbox {
    switch (type.toLowerCase()) {
        case 'browser':
            if (options?.existingPath) {
                throw new Error('existingPath/runPath is supported only for local sandboxes.');
            }
            return new BrowserSandbox();
        case 'local':
        default:
            return new LocalSandbox(options);
    }
}
