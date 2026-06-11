/**
 * Files System Tool
 * 
 * Provides core file management functions for all agents.
 * This tool is always available to the agent.
 */

import * as fs from 'fs';
import * as path from 'path';
// @ts-ignore - mime-types doesn't have perfect TypeScript types
import { lookup } from 'mime-types';

const SUPPORTED_EXTENSIONS = new Set([
    // Text
    '.txt', '.md', '.markdown', '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.py', '.rb', '.go', '.rs', '.c', '.cpp', '.h', '.hpp', '.java', '.php', '.sql', '.yaml', '.yml', '.env', '.xml',
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
    // Documents
    '.pdf',
    // Video
    '.mp4', '.webm', '.mov'
]);

/**
 * View files from the sandbox directory and add them to context
 * Files are read as base64 and stored in .telos-files.json for the Executor to process
 * 
 * @param filePaths - Array of file paths relative to the sandbox directory
 * @param baseDir - Optional base directory (defaults to process.cwd())
 * @returns Object with success status, count of files read, and any errors
 * 
 * @example
 * const result = await files.View(["./document.pdf", "./image.jpg"]);
 * console.log(result.filesRead); // Number of files successfully read
 */
export async function View(
    filePaths: string[],
    baseDir?: string
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

    const sandboxDir = baseDir || process.cwd(); // Sandbox directory is the current working directory or baseDir
    const filesJsonPath = path.join(sandboxDir, '.telos-files.json');

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

            // Check if file type is supported
            const ext = path.extname(absolutePath).toLowerCase();
            const mimeType = lookup(absolutePath);

            const isSupported = SUPPORTED_EXTENSIONS.has(ext) ||
                (mimeType && (mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType === 'application/pdf'));

            if (!isSupported) {
                errors.push(`File extension "${ext}" is not supported for reading`);
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

    // Write files to .telos-files.json
    if (files.length > 0) {
        try {
            fs.writeFileSync(filesJsonPath, JSON.stringify(files, null, 2), 'utf-8');
            console.log(`[Files] Added ${files.length} file(s) to context`);
        } catch (error: any) {
            errors.push(`Failed to write .telos-files.json: ${error.message}`);
        }
    }

    return {
        success: files.length > 0,
        filesRead: files.length,
        errors: errors.length > 0 ? errors : undefined,
    };
}
