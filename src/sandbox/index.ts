/**
 * Sandbox exports
 */

export * from './interfaces.js';
export { LocalSandbox } from './LocalSandbox.js';
export { BrowserSandbox } from './BrowserSandbox.js';

import { LocalSandbox } from './LocalSandbox.js';
import { BrowserSandbox } from './BrowserSandbox.js';
import type { ISandbox } from './interfaces.js';

export function createSandbox(type: string = 'local'): ISandbox {
    switch (type.toLowerCase()) {
        case 'browser':
            return new BrowserSandbox();
        case 'local':
        default:
            return new LocalSandbox();
    }
}
