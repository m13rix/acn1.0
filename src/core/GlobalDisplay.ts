/**
 * GlobalDisplay
 * 
 * Global state for sharing the StreamDisplay instance
 * between CLI and tools (like agents tool).
 */

import { StreamDisplay } from '../cli/display.js';

let globalDisplay: StreamDisplay | null = null;

/**
 * Set the global display instance (called by CLI on startup)
 */
export function setGlobalDisplay(display: StreamDisplay): void {
    globalDisplay = display;
}

/**
 * Get the global display instance. 
 * Automatically creates a default one if none exists (useful in sandbox/tool processes).
 */
export function getGlobalDisplay(): StreamDisplay | null {
    if (!globalDisplay) {
        globalDisplay = new StreamDisplay();
    }
    return globalDisplay;
}

/**
 * Clear the global display (for cleanup)
 */
export function clearGlobalDisplay(): void {
    globalDisplay = null;
}
