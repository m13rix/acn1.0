import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';

const PROJECT_ROOT = "G:\\agent0\\acn1.0";

/**
 * Invalidate Node.js module cache for hot-reload after code changes.
 * This allows newly created/modified agents, tools, and core code to be picked up
 * without restarting the session.
 */
function invalidateModuleCache(): void {
    // Get all cached module paths
    const require = createRequire(import.meta.url);
    const cacheKeys = Object.keys(require.cache);

    // Directories to invalidate (relative to PROJECT_ROOT)
    const invalidateDirs = [
        path.join(PROJECT_ROOT, 'src'),
        path.join(PROJECT_ROOT, 'tools'),
        path.join(PROJECT_ROOT, 'agents'),
        path.join(PROJECT_ROOT, 'dist'),
    ];

    let invalidatedCount = 0;

    for (const key of cacheKeys) {
        // Check if this module is in one of our directories
        const shouldInvalidate = invalidateDirs.some(dir =>
            key.startsWith(dir) || key.includes('acn1.0')
        );

        if (shouldInvalidate) {
            delete require.cache[key];
            invalidatedCount++;
        }
    }

    if (invalidatedCount > 0) {
        console.log(`[srcAgent] Hot-reload: invalidated ${invalidatedCount} cached modules`);
    }
}

/**
 * Sends a request to the external Gemini CLI agent.
 *
 * @param prompt - Detailed description of the request
 * @param directory - Optional directory to run the command in (defaults to PROJECT_ROOT)
 * @returns Promise resolving to the agent's response
 */
export async function sendRequest(prompt: string, directory?: string): Promise<string> {
    const targetDir = directory || PROJECT_ROOT;

    // Exact path and logic from test.js
    const geminiCliPath = 'C:\\Users\\maxim\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js';

    return new Promise((resolve, reject) => {
        const proc = spawn(
            'node',
            [
                geminiCliPath,
                '-p',
                prompt,
                '--yolo',
            ],
            { cwd: targetDir }
        );

        let output = '';
        let stderrOutput = '';

        proc.stdout.on('data', (chunk) => output += chunk.toString());
        proc.stderr.on('data', (chunk) => {
            // Just collect stderr, don't treat as error - Gemini CLI often outputs warnings
            stderrOutput += chunk.toString();
        });

        proc.on('close', (code) => {
            // Hot-reload: invalidate module cache after Gemini CLI completes
            // This ensures any new/modified code is picked up immediately
            invalidateModuleCache();

            // Log stderr only if there was actual content (for debugging)
            if (stderrOutput.trim()) {
                console.log(`[srcAgent] Gemini CLI stderr (ignored): ${stderrOutput.trim().slice(0, 200)}...`);
            }

            // Always resolve with output - Gemini CLI may exit non-zero but still produce valid output
            const result = output.trim();
            if (result) {
                console.log(`[srcAgent] Completed successfully`);
                resolve(result);
            } else if (code !== 0) {
                // Only reject if we have no output AND non-zero exit
                reject(new Error(`srcAgent (Gemini CLI) exited with code ${code}, no output`));
            } else {
                resolve('(no output from Gemini CLI)');
            }
        });

        proc.on('error', (err) => {
            reject(new Error(`Failed to start srcAgent (Gemini CLI): ${err.message}`));
        });
    });
}

