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
import type { AgentMemoryConfig, ExecutionResult, LoadedTool } from '../types/index.js';
import type { ISandbox } from './interfaces.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Path to the built-in skills tool
const SKILLS_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'skills', 'index.ts');
// Path to the built-in files tool
const FILES_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'files', 'index.ts');
// Path to the built-in agents tool
const AGENTS_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'agents', 'index.ts');

export class LocalSandbox implements ISandbox {
    public readonly id: string;
    public readonly directory: string;
    private tools: LoadedTool[] = [];
    private initialized = false;
    private skillsTable: string | undefined;
    private memoryConfig: AgentMemoryConfig | undefined;

    private executionCounter: number = 0; // Counter for execution files, starts at 0
    private executedFiles: Map<string, string> = new Map(); // filename -> filePath mapping for diff support

    constructor(optionsOrBaseDir?: string | { baseDir?: string; existingPath?: string }) {
        if (typeof optionsOrBaseDir === 'object' && optionsOrBaseDir.existingPath) {
            this.id = 'attached'; // Special ID for attached sandboxes
            this.directory = optionsOrBaseDir.existingPath;
        } else {
            const baseDir = typeof optionsOrBaseDir === 'string' ? optionsOrBaseDir : optionsOrBaseDir?.baseDir;
            this.id = randomUUID().slice(0, 8);
            this.directory = join(baseDir || join(PROJECT_ROOT, 'sandboxes'), `session-${this.id}`);
        }
    }

    /**
     * @param tools - Array of loaded tools to make available in the sandbox
     * @param skillsTable - Optional skills table name for the system tool
     * @param memoryConfig - Optional memory configuration for memory tool env wiring
     */
    async initialize(tools: LoadedTool[], skillsTable?: string, memoryConfig?: AgentMemoryConfig): Promise<void> {
        this.tools = tools;
        this.skillsTable = skillsTable;
        this.memoryConfig = memoryConfig;

        if (this.id !== 'attached') {
            // Create sandbox directory
            await mkdir(this.directory, { recursive: true });

            // Create package.json for npm installs
            await this.createPackageJson();

            // Create globals.ts for system functions
            await this.createGlobalsFile();

            // Create tsconfig for the sandbox
            await this.createTsConfig();
        }

        this.initialized = true;
    }

    public getTools(): LoadedTool[] {
        return this.tools;
    }

    getDescription(): string {
        return `## Sandbox (Local)

The agent runs in a local sandbox environment.

### Action
The content of actions is TypeScript code executed locally.
- Use \`console.log(...)\` to produce observations.

### CLI
The content of cli tags are shell commands executed in the sandbox directory.
- Use for npm install, file operations, git, etc.`;
    }

    /**
     * Execute TypeScript code in the sandbox
     * Supports both regular code execution and diff-based editing
     */
    async execute(code: string, language?: string, env?: Record<string, string>, onStderr?: (data: string) => void): Promise<ExecutionResult> {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        // Check if this is a diff format
        // If language is explicitly 'diff', we require it to parse as diff
        const isDiffMode = language === 'diff';
        const diffInfo = this.parseDiff(code);

        if (diffInfo) {
            return this.applyDiff(diffInfo);
        } else if (isDiffMode) {
            // It was supposed to be a diff but failed parsing
            return {
                success: false,
                output: '',
                error: 'Failed to parse diff: Invalid format. Ensure you use standard unified diff format starting with "--- filename" and "+++ filename", followed by "@@ ... @@" blocks.',
            };
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
        const result = await this.runTypeScript(filePath, env, onStderr);

        // Add filename to result
        return {
            ...result,
            filename,
        };
    }

    /**
     * Execute a CLI command in the sandbox directory
     */
    async executeCli(command: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void): Promise<ExecutionResult> {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        // Process command for better compatibility
        let processedCommand = command;

        // 1. Handle multiline commands (join with &&)
        // Split by newline, trim, filter empty
        const lines = command.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('#')); // Skip comments too

        if (lines.length > 1) {
            // Join with && for sequential execution
            processedCommand = lines.join(' && ');
        } else if (lines.length === 1) {
            processedCommand = lines[0];
        } else {
            return { success: true, output: '(empty command)' };
        }

        // 2. Windows-specific fixes
        if (process.platform === 'win32') {
            // Fix "mkdir -p" which creates literal "-p" folder on Windows CMD
            // Windows mkdir is already recursive by default
            // Replace "mkdir -p <path>" with "mkdir <path>"
            // handle "mkdir -p path" and "mkdir -p path1 path2"
            processedCommand = (processedCommand || '').replace(/\bmkdir\s+-p\s+/g, 'mkdir ');
        }

        return this.runShellCommand(processedCommand, onStdout, onStderr);
    }

    /**
     * Run a shell command in the sandbox directory
     */
    private runShellCommand(command: string, onStdout?: (data: string) => void, onStderr?: (data: string) => void): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const stdout: string[] = [];
            const stderr: string[] = [];

            // Build environment with SKILLS_TABLE if configured
            const env: NodeJS.ProcessEnv = { ...process.env };
            if (this.skillsTable) {
                env.SKILLS_TABLE = this.skillsTable;
            }
            this.applyMemoryEnv(env);

            const proc = spawn(command, {
                cwd: this.directory,
                shell: true,
                env,
            });

            proc.stdout.on('data', (data) => {
                const str = data.toString();
                stdout.push(str);
                if (onStdout) {
                    onStdout(str);
                }
            });

            proc.stderr.on('data', (data) => {
                const str = data.toString();
                stderr.push(str);
                if (onStderr) {
                    onStderr(str);
                }
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
        });
    }

    /**
     * Generate the execution file with tool imports
     */
    private generateExecutionFile(code: string): string {
        const requireStatements: string[] = [];

        // Import globals (FINISH function)
        requireStatements.push(`require('./globals.js');`);

        // Always require the files tool (built-in system tool)
        const filesToolRelativePath = this.getRelativePath(FILES_TOOL_PATH);
        requireStatements.push(`const files = require('${filesToolRelativePath}');`);

        // Require the skills tool if configured
        if (this.skillsTable) {
            const skillsToolRelativePath = this.getRelativePath(SKILLS_TOOL_PATH);
            requireStatements.push(`const skills = require('${skillsToolRelativePath}');`);
        }

        // Add user-configured tools
        for (const tool of this.tools) {
            // Skip built-in tools if they were explicitly added in config
            if (tool.config.name === 'skills' || tool.config.name === 'files') continue;

            const relativePath = this.getRelativePath(tool.absolutePath);
            requireStatements.push(`const ${tool.config.name} = require('${relativePath}');`);
        }

        const toolRequires = requireStatements.join('\n');

        // Extract all import/require statements from agent code and convert to require()
        const { imports: agentRequires, codeWithoutImports } = this.extractImports(code);

        // Tool requires stay at the top level (they're static relative requires)
        // Agent requires (npm packages) are converted to require() calls inside the IIFE

        // Wrap the code in an async IIFE to support top-level await
        return `${toolRequires}

// Agent code execution
(async () => {
// Package requires
${agentRequires}

${codeWithoutImports}
})().catch(err => {
  console.error(err);
  process.exit(1);
}).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exit(1);
});
`;
    }

    /**
     * Extract import and require statements from code
     * Returns the requires and the code without those statements
     * Converts ESM imports to CJS require() calls
     */
    private extractImports(code: string): { imports: string; codeWithoutImports: string } {
        const lines = (code || '').split('\n');
        const requires: string[] = [];
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
                    // Complete import on one line - convert to require()
                    const converted = this.convertToRequire(line);
                    if (converted) {
                        requires.push(converted);
                    } else {
                        requires.push(line);
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
                    const converted = this.convertToRequire(currentImport);
                    if (converted) {
                        requires.push(converted);
                    } else {
                        requires.push(currentImport);
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
            const converted = this.convertToRequire(currentImport);
            if (converted) {
                requires.push(converted);
            } else {
                requires.push(currentImport);
            }
        }

        return {
            imports: requires.join('\n'),
            codeWithoutImports: codeLines.join('\n'),
        };
    }

    /**
     * Convert a static ESM import to a CJS require() call
     * Agents can write `import X from 'pkg'` and it'll become `const X = require('pkg')`
     */
    private convertToRequire(importStatement: string): string | null {
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
            return `const ${name} = require('${pkg}');`;
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
            return `const ${name} = require('${pkg}');`;
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
            return `const { ${cleanNames.join(', ')} } = require('${pkg}');`;
        }

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

        // Keep .ts extension — tsx handles TypeScript requires natively
        const requirePath = upPath + downPath;

        return requirePath || './';
    }

    /**
     * Create package.json for npm installs
     */
    private async createPackageJson(): Promise<void> {
        const packageJson = {
            name: `sandbox-${this.id}`,
            version: '1.0.0',
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
                module: 'CommonJS',
                moduleResolution: 'Node',
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
     * Create globals.ts with system functions like FINISH
     */
    private async createGlobalsFile(): Promise<void> {
        const content = `
import { exit } from 'process';

// System function to finish the task
(global as any).FINISH = (message: string) => {
    console.log('__ACN_FINISH_START__' + JSON.stringify(message) + '__ACN_FINISH_END__');
    exit(0);
};

// Type definition for TypeScript (doesn't affect runtime but good for documentation if we generated d.ts)
declare global {
    function FINISH(message: string): void;
}
`;
        await writeFile(join(this.directory, 'globals.ts'), content, 'utf-8');
    }

    /**
     * Run TypeScript file using tsx
     */
    private runTypeScript(
        filePath: string,
        extraEnv?: Record<string, string>,
        onStderr?: (data: string) => void
    ): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const stdout: string[] = [];
            const stderr: string[] = [];

            // Build environment with SKILLS_TABLE if configured and extraEnv
            const env = { ...process.env, ...extraEnv };
            if (this.skillsTable) {
                env.SKILLS_TABLE = this.skillsTable;
            }
            this.applyMemoryEnv(env);
            // Provide sandbox directory to tools, guaranteed string
            env.SANDBOX_DIR = this.directory;
            // Provide project root, fallback to current dir if missing (though calculatedRoot handles it)
            env.PROJECT_ROOT = PROJECT_ROOT || process.cwd();

            // Ensure PATH is a string
            if (process.env.PATH) {
                env.PATH = process.env.PATH;
            }

            const proc = spawn('npx', ['tsx', filePath], {
                cwd: this.directory,
                shell: true,
                env: env as NodeJS.ProcessEnv, // Cast to satisfy type if needed
            });

            proc.stdout.on('data', (data) => {
                stdout.push(data.toString());
            });

            proc.stderr.on('data', (data) => {
                const str = data.toString();
                stderr.push(str);
                if (onStderr) {
                    onStderr(str);
                }
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
        });
    }

    private applyMemoryEnv(env: Record<string, string | undefined>): void {
        const cfg = this.memoryConfig;
        if (!cfg) return;

        if (cfg.table) env.MEMORY_TABLE = cfg.table;
        if (cfg.linkerProvider) env.MEMORY_LINKER_PROVIDER = cfg.linkerProvider;
        if (cfg.linkerModel) env.MEMORY_LINKER_MODEL = cfg.linkerModel;
        if (typeof cfg.linkerTemperature === 'number') env.MEMORY_LINKER_TEMPERATURE = String(cfg.linkerTemperature);
        if (typeof cfg.linkerMaxTokens === 'number') env.MEMORY_LINKER_MAX_TOKENS = String(cfg.linkerMaxTokens);
        if (cfg.embeddingModel) env.MEMORY_EMBEDDING_MODEL = cfg.embeddingModel;
        if (typeof cfg.candidateFactsPerTopic === 'number') env.MEMORY_CANDIDATE_FACTS_PER_TOPIC = String(cfg.candidateFactsPerTopic);
        if (typeof cfg.candidatePoolMax === 'number') env.MEMORY_CANDIDATE_POOL_MAX = String(cfg.candidatePoolMax);
        if (typeof cfg.maxAutoLinksPerFact === 'number') env.MEMORY_MAX_AUTO_LINKS_PER_FACT = String(cfg.maxAutoLinksPerFact);
        if (typeof cfg.dedupeThreshold === 'number') env.MEMORY_DEDUPE_THRESHOLD = String(cfg.dedupeThreshold);
        if (typeof cfg.searchMaxDepth === 'number') env.MEMORY_SEARCH_MAX_DEPTH = String(cfg.searchMaxDepth);
        if (typeof cfg.searchMaxStartFacts === 'number') env.MEMORY_SEARCH_MAX_START_FACTS = String(cfg.searchMaxStartFacts);
        if (typeof cfg.searchMaxChains === 'number') env.MEMORY_SEARCH_MAX_CHAINS = String(cfg.searchMaxChains);
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
            // Relaxed regex to handle LLM hallucinations (garbage text, missing trailing @@)
            // We just look for the numbers pattern: -N,N +N,N
            const hunkMatch = line.match(/[-−](\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/);
            if (hunkMatch) {
                // Determine if this looks like a hunk header (starts with @@ or similar, or just is the numbers)
                // If the line contains typical hunk numbers, we treat it as a header

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

        // Resolve file path relative to sandbox directory
        // Security check: ensure the path stays within sandbox
        const filePath = join(this.directory, filename);
        const relative = this.getRelativePath(filePath);
        if (relative.startsWith('..') && !relative.startsWith('../')) {
            // checks if it tries to go up. getRelativePath returns relative to sandbox.
            // Actually simply:
            if (!filePath.startsWith(this.directory)) {
                return {
                    success: false,
                    output: '',
                    error: `Security Error: Cannot access files outside sandbox: ${filename}`,
                };
            }
        }

        try {
            // Read the current file content
            // This implicitly checks if file exists
            const currentContent = await readFile(filePath, 'utf-8');
            const currentLines = currentContent.split('\n');

            // Apply all hunks using context-based matching
            const modifiedLines = this.applyAllHunks(currentLines, hunks);

            // Write the modified content back
            const newContent = modifiedLines.join('\n');
            await writeFile(filePath, newContent, 'utf-8');

            // If it's a typescript/javascript file, try to execute it to verify (or just because it might be the intention?)
            // The previous logic executed it.
            // The user says "edit... ANY FILE... ts, js, py, txt".
            // Running a txt file makes no sense.
            // If it is TS/JS, maybe we should run it?
            // "The diff editing should look like this... [code] ... generatePresentation().catch..."
            // The example shows code that runs.
            // But if I edit a README.md, I shouldn't run it.

            // Let's check extension.
            if (filename.endsWith('.ts') || filename.endsWith('.js')) {
                const result = await this.runTypeScript(filePath);
                return {
                    ...result,
                    filename,
                };
            }

            return {
                success: true,
                output: `File ${filename} updated successfully.`,
                filename
            };

        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return {
                    success: false,
                    output: '',
                    error: `Cannot apply diff: file "${filename}" not found in sandbox.`,
                };
            }
            return {
                success: false,
                output: '',
                error: `Failed to apply diff: ${error instanceof Error ? error.message : String(error)}`,
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

        const result: string[] = [];
        let originalIndex = 0;
        let hunkIndex = 0;

        while (originalIndex < originalLines.length || hunkIndex < hunksWithPositions.length) {
            const currentHunkObj = hunkIndex < hunksWithPositions.length ? hunksWithPositions[hunkIndex] : null;

            // If we have a hunk and we are at (or past) its start position
            // Note: If we are past its start position (due to previous hunk pushing index forward),
            // we should apply it immediately.
            // But we also need to respect the gap between previous hunk and this one.

            // Actually, we should copy lines until we reach the hunk's match position.
            // But if matchPosition < originalIndex (overlap?), we just apply it now.

            if (currentHunkObj) {
                // Copy lines until we reach the hunk
                while (originalIndex < currentHunkObj.matchPosition && originalIndex < originalLines.length) {
                    result.push(originalLines[originalIndex]!);
                    originalIndex++;
                }

                // Now apply the hunk "smartly"
                const hunk = currentHunkObj.hunk;

                // Smart Hunk Application Logic
                for (const hunkLine of hunk.lines) {
                    if (hunkLine.startsWith('+')) {
                        // Addition: always add
                        result.push(hunkLine.substring(1));
                    } else if (hunkLine.startsWith('-')) {
                        // Deletion: find the line to delete
                        const contentToDelete = hunkLine.substring(1).trim();
                        let foundAt = -1;

                        // Search ahead (limited range) for the line to delete
                        // This handles cases where file has extra lines inserted compared to what hunk expects
                        const searchLimit = 20; // Look ahead 20 lines
                        for (let i = 0; i < searchLimit && (originalIndex + i) < originalLines.length; i++) {
                            if (originalLines[originalIndex + i].trim() === contentToDelete) {
                                foundAt = originalIndex + i;
                                break;
                            }
                        }

                        if (foundAt !== -1) {
                            // Found the line!
                            // Preserve everything before it (if any)
                            while (originalIndex < foundAt) {
                                result.push(originalLines[originalIndex]!);
                                originalIndex++;
                            }
                            // Skip the deleted line
                            originalIndex++;
                        } else {
                            // Line to delete not found within range.
                            // Assume it was already deleted or LLM hallucinated it.
                            // Do not advance originalIndex.
                        }
                    } else if (hunkLine.startsWith(' ')) {
                        // Context: verify matches
                        const contentToMatch = hunkLine.substring(1).trim();
                        let foundAt = -1;

                        const searchLimit = 20;
                        for (let i = 0; i < searchLimit && (originalIndex + i) < originalLines.length; i++) {
                            if (originalLines[originalIndex + i].trim() === contentToMatch) {
                                foundAt = originalIndex + i;
                                break;
                            }
                        }

                        if (foundAt !== -1) {
                            // Found the context line
                            // Preserve everything before it
                            while (originalIndex < foundAt) {
                                result.push(originalLines[originalIndex]);
                                originalIndex++;
                            }
                            // Keep the context line
                            result.push(originalLines[originalIndex]);
                            originalIndex++;
                        } else {
                            // Context line not found.
                            // This suggests desynchronization or changed file.
                            // However, we shouldn't just skip/delete random lines.
                            // Best effort: Just add the context line from the hunk to result?
                            // Or assume it's there but we missed it?
                            // Safest: Keep original line at current index (don't consume it),
                            // but ignore this context requirement from hunk.
                            // This risks duplicating code if we simply ignore.
                            // Actually, if we can't match context, we might be in the wrong place.
                            // But since we are inside the hunk application, we proceed.
                        }
                    }
                }

                hunkIndex++;
            } else {
                // No more hunks, copy remainder
                if (originalIndex < originalLines.length) {
                    result.push(originalLines[originalIndex]);
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

        // Case 1: No context lines (pure addition)
        if (contextLines.length === 0) {
            // If the file is empty, start at 0
            if (lines.length === 0) {
                return 0;
            }
            // If not empty, fallback to the hunk's declared start line
            // This allows adding to the top of file (oldStart=0) or appending
            return Math.min(hunk.oldStart, lines.length);
        }

        // Case 2: Try to match context
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

        // Case 3: Context matching failed completely
        // Fallback to hunk.oldStart logic "don't look at hunk" was user request,
        // but if context fails, we have no other clue.
        // However, we can check if oldStart seems reasonable.
        if (hunk.oldStart <= lines.length) {
            return hunk.oldStart;
        }

        return null;
    }

    /**
     * Parse Search & Replace format from edit block content
     * Format:
     * <<<< SEARCH
     * text to find
     * >>>>
     * <<<< REPLACE
     * replacement text
     * >>>>
     */
    parseSearchReplace(content: string): Array<{ search: string; replace: string }> {
        const edits: Array<{ search: string; replace: string }> = [];
        const text = content.replace(/\r\n/g, '\n');

        // Combined pattern to support both:
        // 1. Standard: <<<< SEARCH ... >>>> <<<< REPLACE ... >>>>
        // 2. Git-style: <<<< SEARCH ... ======= ... >>>>
        // Group 1: Search content
        // Group 2: Replace content
        const regex = /<<<+\s*SEARCH\s*\n([\s\S]*?)\n?(?:>>>+\s*\n<<<+\s*REPLACE|======+)\s*\n?([\s\S]*?)\n?>>>+/gi;

        let match;
        while ((match = regex.exec(text)) !== null) {
            const search = match[1] || '';
            const replace = match[2] || '';
            edits.push({ search, replace });
        }

        return edits;
    }

    /**
     * Apply Search & Replace edits to a file
     * Much simpler and more reliable than unified diff
     */
    async applySearchReplace(filename: string, edits: Array<{ search: string; replace: string }>): Promise<ExecutionResult> {
        // Resolve file path
        const filePath = join(this.directory, filename);

        // Security check
        if (!filePath.startsWith(this.directory)) {
            return {
                success: false,
                output: '',
                error: `Security Error: Cannot access files outside sandbox: ${filename}`,
            };
        }

        try {
            // Read current file
            let content = await readFile(filePath, 'utf-8');
            const appliedEdits: string[] = [];
            const errors: string[] = [];

            // Apply each edit
            for (let i = 0; i < edits.length; i++) {
                const edit = edits[i];
                if (!edit) continue;

                const { search, replace } = edit;

                // Count occurrences
                const occurrences = content.split(search).length - 1;

                if (occurrences === 0) {
                    // Not found - provide helpful error
                    const searchPreview = search.length > 100
                        ? search.substring(0, 100) + '...'
                        : search;
                    errors.push(`Edit #${i + 1}: Text not found:\n"${searchPreview}"\n\nMake sure the SEARCH text matches EXACTLY (including whitespace).`);
                } else if (occurrences > 1) {
                    // Multiple occurrences - ambiguous
                    const searchPreview = search.length > 60
                        ? search.substring(0, 60) + '...'
                        : search;
                    errors.push(`Edit #${i + 1}: Found ${occurrences} matches for:\n"${searchPreview}"\n\nAdd more context to make it unique.`);
                } else {
                    // Exactly one match - apply it
                    content = content.replace(search, replace);
                    appliedEdits.push(`Edit #${i + 1}: Applied successfully`);
                }
            }

            // Write result if any edits were applied
            if (appliedEdits.length > 0) {
                await writeFile(filePath, content, 'utf-8');
            }

            // Build result message
            const summary: string[] = [];
            if (appliedEdits.length > 0) {
                summary.push(`✓ Applied ${appliedEdits.length}/${edits.length} edits to ${filename}`);
            }
            if (errors.length > 0) {
                summary.push(`✗ Failed ${errors.length}/${edits.length} edits:\n${errors.join('\n\n')}`);
            }

            // If it's a TS/JS file and all edits succeeded, run it
            if (errors.length === 0 && (filename.endsWith('.ts') || filename.endsWith('.js'))) {
                const result = await this.runTypeScript(filePath);
                return {
                    ...result,
                    output: summary.join('\n') + '\n\n' + result.output,
                    filename,
                };
            }

            return {
                success: errors.length === 0,
                output: summary.join('\n'),
                error: errors.length > 0 ? 'Some edits failed' : undefined,
                filename,
            };

        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return {
                    success: false,
                    output: '',
                    error: `File not found: "${filename}". Use \`\`\`./filename to create new files.`,
                };
            }
            return {
                success: false,
                output: '',
                error: `Failed to apply edits: ${error.message}`,
            };
        }
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

/**
 * Represents a Search & Replace edit operation
 * Much simpler and more reliable than unified diff
 */
interface SearchReplaceEdit {
    filename: string;
    edits: Array<{
        search: string;   // Exact text to find
        replace: string;  // Text to replace with
    }>;
}

export default LocalSandbox;

