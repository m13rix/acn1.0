/**
 * Environment variable utilities
 * 
 * Provides a helper to load .env files when using the framework programmatically.
 * The CLI automatically loads .env, but library users may need this.
 */

import { config } from 'dotenv';

/**
 * Load environment variables from .env file
 * 
 * @param path - Optional path to .env file (defaults to .env in project root)
 * @returns The result of dotenv config
 * 
 * @example
 * ```ts
 * import { loadEnv } from 'acn/utils/env';
 * loadEnv(); // Loads .env from project root
 * ```
 */
export function loadEnv(path?: string): { error?: Error; parsed?: Record<string, string> } {
  return config(path ? { path } : {});
}

/**
 * Check if .env file exists and can be loaded
 */
export function hasEnvFile(path = '.env'): boolean {
  try {
    const fs = require('fs');
    return fs.existsSync(path);
  } catch {
    return false;
  }
}
