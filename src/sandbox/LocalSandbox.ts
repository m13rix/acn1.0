/**
 * Local Sandbox Manager
 * 
 * Creates isolated execution environments for agent code.
 * Each session gets a fresh sandbox directory.
 */

import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { ExecutionResult, LoadedTool } from '../types/index.js';
import type { ISandbox } from './interfaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Path to the built-in skills tool
const SKILLS_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'skills', 'index.ts');

export class LocalSandbox implements ISandbox {
    public readonly id: string;
    public readonly directory: string;
    private tools: LoadedTool[] = [];
    private initialized = false;
    private skillsTable: string | undefined;
    private executionCounter: number = 0; // Counter for execution files, starts at 0
    private executedFiles: Map<string, string> = new Map(); // filename -> filePath mapping for diff support

    constructor(baseDir?: string) {
        this.id = randomUUID().slice(0, 8);
        this.directory = join(baseDir || join(PROJECT_ROOT, 'sandboxes'), `session-${this.id}`);
    }

    /**
     * Initialize the sandbox with the given tools
     * @param tools - Array of loaded tools to make available in the sandbox
     * @param skillsTable - Optional skills table name for the system tool
     */
    async initialize(tools: LoadedTool[], skillsTable?: string): Promise<void> {
        this.tools = tools;
        this.skillsTable = skillsTable;

        // Create sandbox directory
        await mkdir(this.directory, { recursive: true });

        // Create package.json for npm installs
        await this.createPackageJson();

        // Create tsconfig for the sandbox
        await this.createTsConfig();

        this.initialized = true;
    }

    getDescription(): string {
        return `## Sandbox (Local)

The agent runs in a local sandbox environment.

### Action
The content of actions is TypeScript code executed locally.
- Use \`console.log(...)\` to produce observations.
- New files are created for each execution.
- To edit a previously executed file, use unified diff format:
  \`\`\`
  <action>
  --- exec_0.ts
  +++ exec_0.ts
  @@ -1,5 +1,6 @@
  -function greet(name) {
  -  return "Hello " + name;
  +function greet(name: string): string {
  +  const greeting = "Hello universe";
  +  return \`\${greeting}, \${name}!\`;
   }
  -console.log(greet("world"));
  +console.log(greet("Explorer"));
  </action>
  \`\`\`

### CLI
The content of cli tags are shell commands executed in the sandbox directory.
- Use for npm install, file operations, git, etc.`;
    }

    /**
     * Execute TypeScript code in the sandbox
     * Supports both regular code execution and diff-based editing
     */
    async execute(code: string): Promise<ExecutionResult> {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        // Check if this is a diff format
        const diffInfo = this.parseDiff(code);
        if (diffInfo) {
            return this.applyDiff(diffInfo);
        }

        // Clean code (remove markdown blocks if model included them)
        let cleanedCode = code.trim();
        if (cleanedCode.startsWith('```')) {
            // Remove ```javascript or ```typescript or just ```
            cleanedCode = cleanedCode.replace(/^```[a-z]*\n/i, '').replace(/\n```$/, '');
        }

        // Regular execution - generate the execution file with tool imports
        const fileContent = this.generateExecutionFile(cleanedCode);
        const filename = `exec_${this.executionCounter}.ts`;
        const filePath = join(this.directory, filename);
        this.executionCounter++; // Increment counter for next execution

        await writeFile(filePath, fileContent, 'utf-8');

        // Track this file for future diff edits
        this.executedFiles.set(filename, filePath);

        // Execute with tsx
        const result = await this.runTypeScript(filePath);

        // Add filename to result
        return {
            ...result,
            filename,
        };
    }

    /**
     * Execute a CLI command in the sandbox directory
     */
    async executeCli(command: string): Promise<ExecutionResult> {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        return this.runShellCommand(command);
    }

    /**
     * Run a shell command in the sandbox directory
     */
    private runShellCommand(command: string): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const stdout: string[] = [];
            const stderr: string[] = [];

            // Build environment with SKILLS_TABLE if configured
            const env = { ...process.env };
            if (this.skillsTable) {
                env.SKILLS_TABLE = this.skillsTable;
            }

            const proc = spawn(command, {
                cwd: this.directory,
                shell: true,
                env,
            });

            proc.stdout.on('data', (data) => {
                stdout.push(data.toString());
            });

            proc.stderr.on('data', (data) => {
                stderr.push(data.toString());
            });

            proc.on('error', (error) => {
                resolve({
                    success: false,
                    output: '',
                    error: `Failed to start process: ${error.message}`,
                });
            });

            proc.on('close', (code) => {
                const output = stdout.join('').trim();
                const errorOutput = stderr.join('').trim();

                // Combine stdout and stderr for complete output
                const combinedOutput = [output, errorOutput].filter(Boolean).join('\n');

                if (code === 0) {
                    resolve({
                        success: true,
                        output: combinedOutput || '(no output)',
                    });
                } else {
                    resolve({
                        success: false,
                        output,
                        error: errorOutput || `Process exited with code ${code}`,
                    });
                }
            });

            // Timeout after 5 minutes
            setTimeout(() => {
                proc.kill();
                resolve({
                    success: false,
                    output: stdout.join('').trim(),
                    error: 'Execution timed out (5 minutes limit)',
                });
            }, 300000);
        });
    }

    /**
     * Generate the execution file with tool imports
     */
    private generateExecutionFile(code: string): string {
        const importStatements: string[] = [];

        // Always import the skills tool first (if skills are configured)
        if (this.skillsTable) {
            const skillsToolRelativePath = this.getRelativePath(SKILLS_TOOL_PATH);
            importStatements.push(`import * as skills from '${skillsToolRelativePath}';`);
        }

        // Add user-configured tools
        for (const tool of this.tools) {
            // Skip skills tool if it was explicitly added (we handle it above)
            if (tool.config.name === 'skills') continue;

            const relativePath = this.getRelativePath(tool.absolutePath);
            importStatements.push(`import * as ${tool.config.name} from '${relativePath}';`);
        }

        const toolImports = importStatements.join('\n');

        // Extract all import/export statements from agent code
        const { imports: agentImports, codeWithoutImports } = this.extractImports(code);

        // Tool imports stay at the top level (they're static relative imports)
        // Agent imports (npm packages) are converted to dynamic imports inside the IIFE
        // for better CJS/ESM interop

        // Wrap the code without imports in an async IIFE to support top-level await
        // Dynamic imports (agent imports) go inside the IIFE since they use await
        return `${toolImports}

// Agent code execution
(async () => {
// Dynamic imports for npm packages (CJS/ESM interop)
${agentImports}

${codeWithoutImports}
})().catch(console.error).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
});
`;
    }

    /**
     * Extract import and export statements from code
     * Returns the imports and the code without those statements
     * Converts static imports to dynamic imports to handle CJS/ESM interop for npm packages
     */
    private extractImports(code: string): { imports: string; codeWithoutImports: string } {
        const lines = code.split('\n');
        const imports: string[] = [];
        const codeLines: string[] = [];
        let inMultiLineImport = false;
        let currentImport = '';

        for (const line of lines) {
            const trimmed = line.trim();

            // Check if line starts an import statement (including 'import type')
            const isImport = trimmed.startsWith('import ') || trimmed.startsWith('import\t') || trimmed.startsWith('import{') || trimmed.startsWith('import type ');

            if (isImport) {
                // Check if it's a complete import (ends with semicolon or quote)
                if (trimmed.includes(';') || (trimmed.includes("'") && trimmed.split("'").length >= 3) || (trimmed.includes('"') && trimmed.split('"').length >= 3)) {
                    // Complete import on one line - convert to dynamic import
                    const converted = this.convertToDynamicImport(line);
                    if (converted) {
                        imports.push(converted);
                    } else {
                        imports.push(line);
                    }
                } else {
                    // Multi-line import
                    inMultiLineImport = true;
                    currentImport = line;
                }
            } else if (inMultiLineImport) {
                // Continue building multi-line import
                currentImport += '\n' + line;
                // Check if this line completes the import (has semicolon or closing quote)
                if (line.includes(';') || (line.includes("'") && line.split("'").length >= 3) || (line.includes('"') && line.split('"').length >= 3)) {
                    const converted = this.convertToDynamicImport(currentImport);
                    if (converted) {
                        imports.push(converted);
                    } else {
                        imports.push(currentImport);
                    }
                    inMultiLineImport = false;
                    currentImport = '';
                }
            } else {
                // Regular code line
                codeLines.push(line);
            }
        }

        // Handle case where multi-line import wasn't closed
        if (inMultiLineImport && currentImport) {
            const converted = this.convertToDynamicImport(currentImport);
            if (converted) {
                imports.push(converted);
            } else {
                imports.push(currentImport);
            }
        }

        return {
            imports: imports.join('\n'),
            codeWithoutImports: codeLines.join('\n'),
        };
    }

    /**
     * Convert a static import to a dynamic import for better CJS/ESM interop
     * This helps with npm packages that don't export correctly in ESM
     */
    private convertToDynamicImport(importStatement: string): string | null {
        // Match: import DefaultExport from 'package' or import type DefaultExport from 'package'
        const defaultImportMatch = importStatement.match(/import\s+(?:type\s+)?(\w+)\s+from\s+['"]([^'"]+)['"]/);
        if (defaultImportMatch) {
            const name = defaultImportMatch[1];
            const pkg = defaultImportMatch[2];
            if (!name || !pkg) return null;
            // Skip relative imports (tool imports)
            if (pkg.startsWith('.') || pkg.startsWith('/')) {
                return null;
            }
            // Convert to dynamic import with CJS/ESM interop handling
            return `const ${name} = await (async () => { const m = await import('${pkg}'); return m.default || m; })();`;
        }

        // Match: import * as Name from 'package' or import type * as Name from 'package'
        const namespaceImportMatch = importStatement.match(/import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
        if (namespaceImportMatch) {
            const name = namespaceImportMatch[1];
            const pkg = namespaceImportMatch[2];
            if (!name || !pkg) return null;
            if (pkg.startsWith('.') || pkg.startsWith('/')) {
                return null;
            }
            return `const ${name} = await import('${pkg}');`;
        }

        // Match: import { a, b } from 'package' or import type { a, b } from 'package'
        const namedImportMatch = importStatement.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
        if (namedImportMatch) {
            const names = namedImportMatch[1];
            const pkg = namedImportMatch[2];
            if (!names || !pkg) return null;
            if (pkg.startsWith('.') || pkg.startsWith('/')) {
                return null;
            }
            const cleanNames = names.split(',').map(n => n.trim()).filter(Boolean);
            return `const { ${cleanNames.join(', ')} } = await import('${pkg}');`;
        }

        // Match: import {a,b} from 'package' (no spaces)
        const tightNamedImportMatch = importStatement.match(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
        // (the previous regex already handles it if we adjust the spaces, but let's be explicit if needed)
        // Actually the previous regex handles it.


        return null;
    }

    /**
     * Get relative path from sandbox to a file
     */
    private getRelativePath(absolutePath: string): string {
        // Convert to relative path with forward slashes
        const fromDir = this.directory;
        const toFile = absolutePath;

        // Simple relative path calculation
        // Count how many directories up from sandbox
        const sandboxParts = fromDir.split(/[/\\]/);
        const toolParts = toFile.split(/[/\\]/);

        // Find common prefix
        let commonLength = 0;
        for (let i = 0; i < Math.min(sandboxParts.length, toolParts.length); i++) {
            if (sandboxParts[i] === toolParts[i]) {
                commonLength = i + 1;
            } else {
                break;
            }
        }

        // Build relative path
        const upCount = sandboxParts.length - commonLength;
        const upPath = '../'.repeat(upCount);
        const downPath = toolParts.slice(commonLength).join('/');

        // Remove .ts extension for imports
        const importPath = (upPath + downPath).replace(/\.ts$/, '.js');

        return importPath || './';
    }

    /**
     * Create package.json for npm installs
     */
    private async createPackageJson(): Promise<void> {
        const packageJson = {
            name: `sandbox-${this.id}`,
            version: '1.0.0',
            type: 'module',
            description: 'ACN agent sandbox',
            private: true,
        };

        const packageJsonPath = join(this.directory, 'package.json');
        const packageJsonContent = JSON.stringify(packageJson, null, 2);

        await writeFile(packageJsonPath, packageJsonContent, 'utf-8');
    }

    /**
     * Create tsconfig.json for the sandbox
     */
    private async createTsConfig(): Promise<void> {
        const tsconfig = {
            compilerOptions: {
                target: 'ES2022',
                module: 'NodeNext',
                moduleResolution: 'NodeNext',
                esModuleInterop: true,
                allowSyntheticDefaultImports: true,
                strict: false,  // Allow loose typing in agent code
                skipLibCheck: true,
            },
        };

        const tsconfigPath = join(this.directory, 'tsconfig.json');
        const tsconfigContent = JSON.stringify(tsconfig, null, 2);

        await writeFile(tsconfigPath, tsconfigContent, 'utf-8');
    }

    /**
     * Run TypeScript file using tsx
     */
    private runTypeScript(filePath: string): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const stdout: string[] = [];
            const stderr: string[] = [];

            // Build environment with SKILLS_TABLE if configured
            const env = { ...process.env };
            if (this.skillsTable) {
                env.SKILLS_TABLE = this.skillsTable;
            }

            const proc = spawn('npx', ['tsx', filePath], {
                cwd: this.directory,
                shell: true,
                env,
            });

            proc.stdout.on('data', (data) => {
                stdout.push(data.toString());
            });

            proc.stderr.on('data', (data) => {
                stderr.push(data.toString());
            });

            proc.on('error', (error) => {
                resolve({
                    success: false,
                    output: '',
                    error: `Failed to start process: ${error.message}`,
                });
            });

            proc.on('close', (code) => {
                const output = stdout.join('').trim();
                const errorOutput = stderr.join('').trim();

                if (code === 0) {
                    resolve({
                        success: true,
                        output: output || '(no output)',
                    });
                } else {
                    resolve({
                        success: false,
                        output,
                        error: errorOutput || `Process exited with code ${code}`,
                    });
                }
            });

            // Timeout after 5 minutes
            setTimeout(() => {
                proc.kill();
                resolve({
                    success: false,
                    output: stdout.join('').trim(),
                    error: 'Execution timed out (5 minutes limit)',
                });
            }, 300000);
        });
    }

    /**
     * Detect if code is a unified diff format
     * Returns parsed diff info or null if not a diff
     */
    private parseDiff(code: string): { filename: string; hunks: DiffHunk[] } | null {
        const lines = code.split('\n');
        if (lines.length < 3) return null;

        // Check for unified diff header: --- filename and +++ filename
        const firstLine = lines[0]?.trim();
        const secondLine = lines[1]?.trim();

        if (!firstLine || !secondLine || !firstLine.startsWith('--- ') || !secondLine.startsWith('+++ ')) {
            return null;
        }

        // Extract filename (strip "--- " or "+++ " prefix)
        // TypeScript now knows firstLine and secondLine are strings after the checks above
        const oldFilename = (firstLine as string).substring(4).trim();
        const newFilename = (secondLine as string).substring(4).trim();

        // Both filenames should be the same for editing existing files
        // (we only support editing, not renaming)
        if (oldFilename !== newFilename) {
            return null;
        }

        const filename = oldFilename;

        // Parse diff hunks
        const hunks: DiffHunk[] = [];
        let i = 2; // Start after header lines

        while (i < lines.length) {
            const line = lines[i];
            if (!line) {
                i++;
                continue;
            }

            // Look for hunk header: @@ -start,count +start,count @@
            const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (hunkMatch) {
                const oldStartStr = hunkMatch[1];
                const oldCountStr = hunkMatch[2];
                const newStartStr = hunkMatch[3];
                const newCountStr = hunkMatch[4];

                if (!oldStartStr || !newStartStr) {
                    i++;
                    continue;
                }

                const oldStart = parseInt(oldStartStr, 10);
                const oldCount = oldCountStr ? parseInt(oldCountStr, 10) : 1;
                const newStart = parseInt(newStartStr, 10);
                const newCount = newCountStr ? parseInt(newCountStr, 10) : 1;

                const hunk: DiffHunk = {
                    oldStart: oldStart - 1, // Convert to 0-based
                    oldCount,
                    newStart: newStart - 1, // Convert to 0-based
                    newCount,
                    lines: [],
                };

                i++; // Move past hunk header

                // Parse hunk lines
                while (i < lines.length) {
                    const hunkLine = lines[i];
                    if (!hunkLine) {
                        i++;
                        continue;
                    }

                    // Stop at next hunk header or end of diff
                    if (hunkLine.match(/^@@/)) {
                        break;
                    }

                    if (hunkLine.startsWith(' ') || hunkLine.startsWith('-') || hunkLine.startsWith('+')) {
                        hunk.lines.push(hunkLine);
                        i++;
                    } else {
                        // Empty line or context separator - skip
                        i++;
                    }
                }

                hunks.push(hunk);
            } else {
                i++;
            }
        }

        if (hunks.length === 0) {
            return null; // No valid hunks found
        }

        return { filename, hunks };
    }

    /**
     * Apply a unified diff to an existing file
     */
    private async applyDiff(diffInfo: { filename: string; hunks: DiffHunk[] }): Promise<ExecutionResult> {
        const { filename, hunks } = diffInfo;

        // Find the file path (must be an executed file we've tracked)
        const filePath = this.executedFiles.get(filename);
        if (!filePath) {
            return {
                success: false,
                output: '',
                error: `Cannot apply diff: file "${filename}" not found. Only previously executed files can be edited with diffs.`,
            };
        }

        try {
            // Read the current file content
            const currentContent = await readFile(filePath, 'utf-8');
            const currentLines = currentContent.split('\n');

            // Apply all hunks using context-based matching
            const modifiedLines = this.applyAllHunks(currentLines, hunks);

            // Write the modified content back
            const newContent = modifiedLines.join('\n');
            await writeFile(filePath, newContent, 'utf-8');

            // Execute the modified file
            const result = await this.runTypeScript(filePath);

            return {
                ...result,
                filename,
            };
        } catch (error: any) {
            return {
                success: false,
                output: '',
                error: `Failed to apply diff: ${error.message}`,
            };
        }
    }

    /**
     * Apply all hunks using context-based matching instead of line numbers
     * This is more robust and handles cases where line numbers don't match
     */
    private applyAllHunks(originalLines: string[], hunks: DiffHunk[]): string[] {
        if (hunks.length === 0) {
            return [...originalLines];
        }

        // Find positions for all hunks using context matching
        const hunksWithPositions = hunks
            .map(hunk => ({
                hunk,
                matchPosition: this.findHunkPosition(originalLines, hunk),
            }))
            .filter(hp => hp.matchPosition !== null) as Array<{ hunk: DiffHunk; matchPosition: number }>;

        // Sort by position ascending so we can apply in order (top to bottom)
        // All positions are relative to the original file, so we apply in a single pass
        hunksWithPositions.sort((a, b) => a.matchPosition - b.matchPosition);

        if (hunksWithPositions.length === 0) {
            // No hunks could be matched - return original
            return [...originalLines];
        }

        // Apply all hunks in a single pass using matched positions
        const result: string[] = [];
        let originalIndex = 0;
        let hunkIndex = 0;

        while (originalIndex < originalLines.length || hunkIndex < hunksWithPositions.length) {
            const currentHunk = hunkIndex < hunksWithPositions.length ? hunksWithPositions[hunkIndex] : null;

            if (currentHunk && originalIndex === currentHunk.matchPosition) {
                // Apply this hunk
                const hunk = currentHunk.hunk;
                let hunkLineIndex = 0;
                let originalLinesConsumed = 0;

                // Process hunk lines
                while (hunkLineIndex < hunk.lines.length) {
                    const hunkLine = hunk.lines[hunkLineIndex];
                    if (!hunkLine) {
                        hunkLineIndex++;
                        continue;
                    }

                    if (hunkLine.startsWith(' ')) {
                        // Context line - keep it if it matches
                        if (originalIndex < originalLines.length) {
                            const contextContent = hunkLine.substring(1);
                            const originalLine = originalLines[originalIndex];
                            if (originalLine !== undefined) {
                                if (originalLine.trim() === contextContent.trim()) {
                                    result.push(originalLine);
                                } else {
                                    // Mismatch - keep original anyway
                                    result.push(originalLine);
                                }
                            }
                            originalIndex++;
                            originalLinesConsumed++;
                        }
                        hunkLineIndex++;
                    } else if (hunkLine.startsWith('-')) {
                        // Line to remove - skip it
                        if (originalIndex < originalLines.length) {
                            originalIndex++;
                            originalLinesConsumed++;
                        }
                        hunkLineIndex++;
                    } else if (hunkLine.startsWith('+')) {
                        // Line to add
                        result.push(hunkLine.substring(1));
                        hunkLineIndex++;
                    } else {
                        hunkLineIndex++;
                    }
                }

                hunkIndex++;
            } else if (currentHunk && originalIndex < currentHunk.matchPosition) {
                // Copy original lines until we reach the next hunk
                if (originalIndex < originalLines.length) {
                    const line = originalLines[originalIndex];
                    if (line !== undefined) {
                        result.push(line);
                    }
                }
                originalIndex++;
            } else {
                // No more hunks, copy remaining original lines
                if (originalIndex < originalLines.length) {
                    const line = originalLines[originalIndex];
                    if (line !== undefined) {
                        result.push(line);
                    }
                    originalIndex++;
                } else {
                    break;
                }
            }
        }

        return result;
    }

    /**
     * Find the position of a hunk in the file using context line matching
     * Returns the line number where the hunk should be applied, or null if not found
     */
    private findHunkPosition(lines: string[], hunk: DiffHunk): number | null {
        // Extract context lines (lines that start with ' ' or '-')
        // These represent lines that should exist in the original file
        const contextLines: string[] = [];
        for (const hunkLine of hunk.lines) {
            if (hunkLine.startsWith(' ') || hunkLine.startsWith('-')) {
                const content = hunkLine.substring(1); // Remove prefix
                contextLines.push(content);
            }
        }

        if (contextLines.length === 0) {
            // No context to match - can't locate this hunk reliably
            return null;
        }

        // Try to find a sequence of matching context lines in the file
        // We need at least 2-3 matching consecutive lines to be confident
        const minContextMatch = Math.min(3, contextLines.length);

        for (let i = 0; i <= lines.length - minContextMatch; i++) {
            let matches = 0;
            let matchStart = i;

            // Check if we can match context lines starting at position i
            for (let j = 0; j < contextLines.length && (i + j) < lines.length; j++) {
                const hunkContextLine = contextLines[j];
                const fileLine = lines[i + j];

                if (hunkContextLine === undefined || fileLine === undefined) {
                    continue;
                }

                // Trim both for comparison (diff context lines may have trailing spaces)
                if (hunkContextLine.trim() === fileLine.trim()) {
                    matches++;
                } else {
                    // Allow a few mismatches, but break if too many
                    if (matches > 0 && j > matches + 2) {
                        break; // Too many mismatches
                    }
                }
            }

            // If we found a good match (at least minContextMatch lines), return the position
            if (matches >= minContextMatch) {
                return matchStart;
            }
        }

        // Try a more lenient match: look for the first unique context line
        const firstContextLine = contextLines[0];
        if (contextLines.length >= 1 && firstContextLine !== undefined) {
            const firstContext = firstContextLine.trim();
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line !== undefined && line.trim() === firstContext) {
                    // Verify we can match a few more lines after this
                    let subsequentMatches = 1;
                    for (let j = 1; j < Math.min(contextLines.length, 5) && (i + j) < lines.length; j++) {
                        const contextLine = contextLines[j];
                        const nextFileLine = lines[i + j];
                        if (contextLine !== undefined && nextFileLine !== undefined && contextLine.trim() === nextFileLine.trim()) {
                            subsequentMatches++;
                        }
                    }
                    if (subsequentMatches >= 2) {
                        return i;
                    }
                }
            }
        }

        return null;
    }


    /**
     * Clean up the sandbox directory
     */
    async cleanup(): Promise<void> {
        try {
            await rm(this.directory, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }
}

/**
 * Represents a diff hunk in unified diff format
 */
interface DiffHunk {
    oldStart: number; // 0-based line number
    oldCount: number; // Number of lines in old file
    newStart: number; // 0-based line number
    newCount: number; // Number of lines in new file
    lines: string[]; // The diff lines (with +, -, or space prefix)
}

export default LocalSandbox;
