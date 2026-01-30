/**
 * Files System Tool
 * 
 * Provides core file management functions for all agents.
 * This tool is always available to the agent.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * View files from the sandbox directory and add them to context
 * Files are read as base64 and stored in .acn-files.json for the Executor to process
 * 
 * @param filePaths - Array of file paths relative to the sandbox directory
 * @returns Object with success status, count of files read, and any errors
 * 
 * @example
 * const result = await files.View(["./document.pdf", "./image.jpg"]);
 * console.log(result.filesRead); // Number of files successfully read
 */
export async function View(
    filePaths: string[]
): Promise<{ success: boolean; filesRead: number; errors?: string[] }> {
    if (!filePaths || !Array.isArray(filePaths) || filePaths.length === 0) {
        throw new Error('filePaths must be a non-empty array');
    }

    // Validate all paths are strings
    for (const filePath of filePaths) {
        if (typeof filePath !== 'string' || !filePath.trim()) {
            throw new Error('All file paths must be non-empty strings');
        }
    }

    const sandboxDir = process.cwd(); // Sandbox directory is the current working directory
    const filesJsonPath = path.join(sandboxDir, '.acn-files.json');

    const files: Array<{ content: string; filename: string }> = [];
    const errors: string[] = [];

    for (const filePath of filePaths) {
        try {
            const absolutePath = path.resolve(sandboxDir, filePath);

            // Security: Ensure the path is within the sandbox directory
            if (!absolutePath.startsWith(path.resolve(sandboxDir))) {
                errors.push(`Path "${filePath}" is outside sandbox directory`);
                continue;
            }

            // Check if file exists
            if (!fs.existsSync(absolutePath)) {
                errors.push(`File "${filePath}" not found`);
                continue;
            }

            // Check if it's a file (not a directory)
            const stats = fs.statSync(absolutePath);
            if (!stats.isFile()) {
                errors.push(`"${filePath}" is not a file`);
                continue;
            }

            // Read file as base64
            const base64Content = fs.readFileSync(absolutePath, { encoding: 'base64' });
            const filename = path.basename(absolutePath);

            files.push({
                content: base64Content,
                filename: filename,
            });

            console.log(`[Files] Read file: ${filename} (${stats.size} bytes)`);
        } catch (error: any) {
            errors.push(`Failed to read "${filePath}": ${error.message}`);
        }
    }

    // Write files to .acn-files.json
    if (files.length > 0) {
        try {
            fs.writeFileSync(filesJsonPath, JSON.stringify(files, null, 2), 'utf-8');
            console.log(`[Files] Added ${files.length} file(s) to context`);
        } catch (error: any) {
            errors.push(`Failed to write .acn-files.json: ${error.message}`);
        }
    }

    return {
        success: files.length > 0,
        filesRead: files.length,
        errors: errors.length > 0 ? errors : undefined,
    };
}
