/**
 * Sandbox Manager
 * 
 * Creates isolated execution environments for agent code.
 * Each session gets a fresh sandbox directory.
 */

import { spawn } from 'child_process';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { ExecutionResult, LoadedTool } from '../types/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Path to the built-in system tool
const SYSTEM_TOOL_PATH = join(PROJECT_ROOT, 'tools', 'system', 'index.ts');

export class Sandbox {
  public readonly id: string;
  public readonly directory: string;
  private tools: LoadedTool[] = [];
  private initialized = false;
  private skillsTable: string | undefined;
  
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
  
  /**
   * Execute TypeScript code in the sandbox
   */
  async execute(code: string): Promise<ExecutionResult> {
    if (!this.initialized) {
      throw new Error('Sandbox not initialized. Call initialize() first.');
    }
    
    // Generate the execution file with tool imports
    const fileContent = this.generateExecutionFile(code);
    const filePath = join(this.directory, `exec-${Date.now()}.ts`);
    
    await writeFile(filePath, fileContent, 'utf-8');
    
    // Execute with tsx
    return this.runTypeScript(filePath);
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
      
      // Timeout after 30 seconds
      setTimeout(() => {
        proc.kill();
        resolve({
          success: false,
          output: stdout.join('').trim(),
          error: 'Execution timed out (30s limit)',
        });
      }, 30000);
    });
  }
  
  /**
   * Generate the execution file with tool imports
   */
  private generateExecutionFile(code: string): string {
    const importStatements: string[] = [];
    
    // Always import the system tool first (if skills are configured)
    if (this.skillsTable) {
      const systemToolRelativePath = this.getRelativePath(SYSTEM_TOOL_PATH);
      importStatements.push(`import * as system from '${systemToolRelativePath}';`);
    }
    
    // Add user-configured tools
    for (const tool of this.tools) {
      // Skip system tool if it was explicitly added (we handle it above)
      if (tool.config.name === 'system') continue;
      
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
      
      // Check if line starts an import statement
      if (trimmed.startsWith('import ') || trimmed.startsWith('import\t')) {
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
    // Match: import DefaultExport from 'package'
    const defaultImportMatch = importStatement.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
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
    
    // Match: import * as Name from 'package'
    const namespaceImportMatch = importStatement.match(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (namespaceImportMatch) {
      const name = namespaceImportMatch[1];
      const pkg = namespaceImportMatch[2];
      if (!name || !pkg) return null;
      if (pkg.startsWith('.') || pkg.startsWith('/')) {
        return null;
      }
      return `const ${name} = await import('${pkg}');`;
    }
    
    // Match: import { a, b } from 'package'
    const namedImportMatch = importStatement.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
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
      
      // Timeout after 30 seconds
      setTimeout(() => {
        proc.kill();
        resolve({
          success: false,
          output: stdout.join('').trim(),
          error: 'Execution timed out (30s limit)',
        });
      }, 30000);
    });
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

export default Sandbox;
