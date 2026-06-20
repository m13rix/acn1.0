/**
 * Files system package.
 *
 * Automatically injected into every LocalSandbox action as `files`.
 */

import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
// @ts-ignore - mime-types does not always ship perfect typings here.
import { lookup } from 'mime-types';

type ReadOptions = {
    startLine?: number;
    endLine?: number;
    aroundLine?: number;
    context?: number;
    raw?: boolean;
    lineNumbers?: boolean;
    allowExternal?: boolean;
};

type SearchOptions = {
    dir?: string;
    path?: string;
    glob?: string;
    maxResults?: number;
    includeIgnored?: boolean;
    previewChars?: number;
    recursive?: boolean;
    caseSensitive?: boolean;
    allowExternal?: boolean;
};

type ListOptions = {
    depth?: number;
    includeSizes?: boolean;
    maxEntries?: number;
    includeIgnored?: boolean;
    allowExternal?: boolean;
};

type EditOperation = {
    old: string;
    new: string;
    replaceAll?: boolean;
    occurrence?: number;
};

type ExternalAccessOptions = {
    allowExternal?: boolean;
};

const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_SEARCH_PREVIEW_CHARS = 240;
const DEFAULT_LIST_DEPTH = 2;
const DEFAULT_MAX_LIST_ENTRIES = 500;
const HIDDEN_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'data',
    'data/adaptive-step-context',
    'sandboxes',
    'browser-profile',
    '.telos-advanced-cli',
]);
const HIDDEN_FILE_GLOBS = [
    '!**/*.log',
    '!**/log.txt',
    '!**/.telos-*',
    '!**/exec_*.cts',
];
const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.mdx', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.cts', '.mts',
    '.json', '.jsonl', '.html', '.htm', '.css', '.scss', '.sass', '.less', '.py', '.rb', '.go', '.rs',
    '.c', '.cc', '.cpp', '.h', '.hpp', '.java', '.kt', '.kts', '.php', '.sql', '.yaml', '.yml', '.toml',
    '.ini', '.env', '.xml', '.svg', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd', '.csv', '.tsv',
    '.log', '.gitignore', '.gitattributes', '.dockerignore',
]);

type SearchRow = {
    path: string;
    line: number;
    preview: string;
};

function sandboxRoot(): string {
    return path.resolve(process.env.SANDBOX_DIR || process.cwd());
}

function isInsidePath(root: string, target: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(target));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveAccessPath(inputPath: string, baseDir = sandboxRoot(), options?: ExternalAccessOptions): string {
    if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
        throw new Error('path must be a non-empty string');
    }

    const root = path.resolve(baseDir);
    const target = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(root, inputPath);
    if (!options?.allowExternal && !isInsidePath(root, target)) {
        throw new Error(`Security Error: path resolves outside sandbox: ${inputPath}. Pass { allowExternal: true } to intentionally access files outside the project.`);
    }
    return target;
}

function toDisplayPath(absolutePath: string, displayRoot = sandboxRoot()): string {
    if (!isInsidePath(displayRoot, absolutePath)) {
        return path.resolve(absolutePath).split(path.sep).join('/');
    }
    const relative = path.relative(displayRoot, absolutePath) || '.';
    return relative.split(path.sep).join('/');
}

function truncatePreview(value: string, maxChars = DEFAULT_SEARCH_PREVIEW_CHARS): string {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    const limit = Math.max(40, Math.floor(maxChars));
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...[truncated ${text.length - limit} chars; use files.read around this line]`;
}

function isHiddenRelativePath(relativePath: string): boolean {
    const normalized = relativePath.split(path.sep).join('/');
    for (const hidden of HIDDEN_DIRS) {
        if (normalized === hidden || normalized.startsWith(`${hidden}/`)) {
            return true;
        }
    }
    return false;
}

function isHiddenFileRelativePath(relativePath: string): boolean {
    const basename = path.basename(relativePath);
    return basename === 'log.txt'
        || basename.endsWith('.log')
        || basename.startsWith('.telos-')
        || /^exec_\d+\.cts$/i.test(basename);
}

function runProcess(command: string, args: string[], options: { cwd: string }): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        execFile(command, args, { cwd: options.cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            const code = typeof (error as any)?.code === 'number' ? (error as any).code : (error ? 1 : 0);
            resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

function isProbablyText(buffer: Buffer, filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = String(lookup(filePath) || '');
    if (TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/')) {
        return true;
    }
    if (buffer.includes(0)) {
        return false;
    }
    const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
    if (sample.length === 0) {
        return true;
    }
    let suspicious = 0;
    for (const byte of sample) {
        if (byte < 7 || (byte > 14 && byte < 32)) {
            suspicious++;
        }
    }
    return suspicious / sample.length < 0.03;
}

function numberLines(content: string, startLine: number, endLine: number): string {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const start = Math.max(1, Math.min(startLine, lines.length || 1));
    const end = Math.max(start, Math.min(endLine, lines.length || 1));
    const width = String(end).length;
    const out: string[] = [];
    for (let lineNumber = start; lineNumber <= end; lineNumber++) {
        out.push(`${String(lineNumber).padStart(width, ' ')} | ${lines[lineNumber - 1] ?? ''}`);
    }
    return out.join('\n');
}

function resolveReadRange(totalLines: number, options?: ReadOptions): { startLine: number; endLine: number } {
    if (options?.aroundLine !== undefined) {
        const aroundLine = Math.max(1, Math.floor(options.aroundLine));
        const context = Math.max(0, Math.floor(options.context ?? 20));
        return {
            startLine: Math.max(1, aroundLine - context),
            endLine: Math.min(totalLines, aroundLine + context),
        };
    }

    return {
        startLine: Math.max(1, Math.floor(options?.startLine ?? 1)),
        endLine: Math.max(1, Math.floor(options?.endLine ?? totalLines)),
    };
}

function hasReadRange(options?: ReadOptions): boolean {
    return options?.aroundLine !== undefined || options?.startLine !== undefined || options?.endLine !== undefined;
}

async function appendFileObservation(filePath: string): Promise<void> {
    const root = sandboxRoot();
    const filesJsonPath = path.join(root, '.telos-files.json');
    let existing: Array<{ content: string; filename: string }> = [];
    try {
        existing = JSON.parse(await fsp.readFile(filesJsonPath, 'utf-8'));
        if (!Array.isArray(existing)) existing = [];
    } catch {
        existing = [];
    }

    existing.push({
        content: await fsp.readFile(filePath, { encoding: 'base64' }),
        filename: toDisplayPath(filePath),
    });
    await fsp.writeFile(filesJsonPath, JSON.stringify(existing, null, 2), 'utf-8');
}

export async function read(filePath: string, options?: ReadOptions): Promise<string> {
    const targetPath = resolveAccessPath(filePath, sandboxRoot(), options);
    const stats = await fsp.stat(targetPath);
    if (!stats.isFile()) {
        throw new Error(`${filePath} is not a file`);
    }

    const buffer = await fsp.readFile(targetPath);
    if (!isProbablyText(buffer, targetPath)) {
        await appendFileObservation(targetPath);
        return `Attached non-text file observation for ${toDisplayPath(targetPath)} (${stats.size} bytes). The next model step will receive it as user-side multimodal context when the provider supports it.`;
    }

    const content = buffer.toString('utf-8');
    if (options?.raw === true || (options?.lineNumbers !== true && !hasReadRange(options))) {
        return content;
    }

    const lineCount = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').length;
    const range = resolveReadRange(lineCount, options);
    return numberLines(content, range.startLine, range.endLine);
}

function isCaseSensitiveSearch(query: string, options: SearchOptions): boolean {
    if (options.caseSensitive !== undefined) {
        return options.caseSensitive;
    }
    return /[A-Z]/.test(query);
}

function normalizeForSearch(value: string, caseSensitive: boolean): string {
    return caseSensitive ? value : value.toLocaleLowerCase();
}

async function searchWithFilesystem(query: string, searchDir: string, maxResults: number, caseSensitive: boolean, includeIgnored: boolean, previewChars: number): Promise<SearchRow[]> {
    const needle = normalizeForSearch(query, caseSensitive);
    const rows: SearchRow[] = [];

    async function visit(current: string): Promise<void> {
        if (rows.length >= maxResults) return;

        const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (rows.length >= maxResults) return;
            if (entry.isDirectory()) {
                if (!includeIgnored && isHiddenRelativePath(path.relative(sandboxRoot(), path.join(current, entry.name)))) continue;
                await visit(path.join(current, entry.name));
                continue;
            }
            if (!entry.isFile()) continue;

            const absolute = path.join(current, entry.name);
            if (!includeIgnored && isHiddenFileRelativePath(path.relative(sandboxRoot(), absolute))) continue;
            const buffer = await fsp.readFile(absolute).catch(() => null);
            if (!buffer || !isProbablyText(buffer, absolute)) continue;

            const lines = buffer.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
            for (let index = 0; index < lines.length; index++) {
                const line = lines[index] ?? '';
                if (normalizeForSearch(line, caseSensitive).includes(needle)) {
                    rows.push({
                        path: toDisplayPath(absolute),
                        line: index + 1,
                        preview: truncatePreview(line, previewChars),
                    });
                    if (rows.length >= maxResults) return;
                }
            }
        }
    }

    await visit(searchDir);
    return rows;
}

export async function search(query: string, options: SearchOptions = {}): Promise<SearchRow[]> {
    if (typeof query !== 'string' || query.length === 0) {
        throw new Error('query must be a non-empty string');
    }

    const root = sandboxRoot();
    const searchDir = resolveAccessPath(options.dir || options.path || '.', root, options);
    const maxResults = Math.max(1, Math.floor(options.maxResults ?? DEFAULT_MAX_RESULTS));
    const includeIgnored = options.includeIgnored === true;
    const previewChars = Math.max(40, Math.floor(options.previewChars ?? DEFAULT_SEARCH_PREVIEW_CHARS));
    const caseSensitive = isCaseSensitiveSearch(query, options);
    const args = [
        '--line-number',
        '--no-heading',
        '--color',
        'never',
        caseSensitive ? '--case-sensitive' : '--ignore-case',
    ];
    if (!includeIgnored) {
        for (const hidden of HIDDEN_DIRS) {
            args.push('--glob', `!${hidden}/**`);
        }
        for (const hiddenGlob of HIDDEN_FILE_GLOBS) {
            args.push('--glob', hiddenGlob);
        }
    }
    if (options.glob) {
        args.push('--glob', options.glob);
    }
    args.push(query, '.');

    const result = await runProcess('rg', args, { cwd: searchDir });
    if (result.code !== 0 && !result.stdout.trim()) {
        if (/not recognized|ENOENT|not found/i.test(result.stderr)) {
            throw new Error('files.search requires ripgrep (`rg`) to be installed');
        }
        return searchWithFilesystem(query, searchDir, maxResults, caseSensitive, includeIgnored, previewChars);
    }

    const rows = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults).map((line) => {
        const match = line.match(/^(.*?):(\d+):(.*)$/);
        if (!match) {
            return null;
        }
        const absolute = path.resolve(searchDir, match[1] || '');
        return {
            path: toDisplayPath(absolute),
            line: Number(match[2]),
            preview: truncatePreview(match[3] || '', previewChars),
        };
    }).filter(Boolean);

    return rows;
}

type TreeNode = {
    name: string;
    path: string;
    isDir: boolean;
    size?: number;
    children: Map<string, TreeNode>;
};

function makeTreeNode(name: string, nodePath: string, isDir: boolean, size?: number): TreeNode {
    return { name, path: nodePath, isDir, size, children: new Map() };
}

async function rgFiles(root: string, targetPath: string, includeIgnored: boolean): Promise<string[] | null> {
    const rel = path.relative(root, targetPath) || '.';
    const args = ['--files'];
    if (!includeIgnored && !isHiddenRelativePath(rel)) {
        for (const hidden of HIDDEN_DIRS) {
            args.push('--glob', `!${hidden}/**`);
        }
        for (const hiddenGlob of HIDDEN_FILE_GLOBS) {
            args.push('--glob', hiddenGlob);
        }
    }
    args.push(rel);
    const result = await runProcess('rg', args, { cwd: root });
    if (result.code !== 0 && !result.stdout.trim()) {
        return null;
    }
    return result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((entry) => entry.split(/[\\/]/).join('/').replace(/^\.\//, ''));
}

async function fsFiles(targetPath: string, root: string, maxDepth: number, includeIgnored: boolean): Promise<string[]> {
    const out: string[] = [];
    async function visit(current: string, depth: number): Promise<void> {
        if (depth > maxDepth) return;
        const entries = await fsp.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            if (!includeIgnored && entry.isDirectory() && isHiddenRelativePath(path.relative(root, absolute))) {
                continue;
            }
            if (!includeIgnored && entry.isFile() && isHiddenFileRelativePath(path.relative(root, absolute))) {
                continue;
            }
            out.push(path.relative(root, absolute).split(path.sep).join('/'));
            if (entry.isDirectory()) {
                await visit(absolute, depth + 1);
            }
        }
    }
    await visit(targetPath, 1);
    return out;
}

function addPathToTree(root: TreeNode, relativePath: string, isFile: boolean, size?: number): void {
    const parts = relativePath.split('/').filter(Boolean);
    let current = root;
    for (let index = 0; index < parts.length; index++) {
        const part = parts[index]!;
        const leaf = index === parts.length - 1;
        const childPath = current.path ? `${current.path}/${part}` : part;
        let child = current.children.get(part);
        if (!child) {
            child = makeTreeNode(part, childPath, !leaf || !isFile, leaf ? size : undefined);
            current.children.set(part, child);
        }
        if (leaf && isFile) {
            child.isDir = false;
            child.size = size;
        }
        current = child;
    }
}

function formatSize(bytes?: number): string {
    if (bytes === undefined) return '';
    if (bytes < 1024) return ` (${bytes} B)`;
    if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`;
    return ` (${(bytes / 1024 / 1024).toFixed(1)} MB)`;
}

function renderTree(node: TreeNode, options: Required<Pick<ListOptions, 'includeSizes' | 'maxEntries'>>, state: { count: number; truncated: boolean }, indent = ''): string[] {
    if (state.count >= options.maxEntries) {
        state.truncated = true;
        return [];
    }

    const entries = Array.from(node.children.values()).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    const lines: string[] = [];
    for (const entry of entries) {
        if (state.count >= options.maxEntries) {
            state.truncated = true;
            break;
        }
        state.count++;
        lines.push(`${indent}${entry.name}${entry.isDir ? '/' : options.includeSizes ? formatSize(entry.size) : ''}`);
        if (entry.isDir) {
            lines.push(...renderTree(entry, options, state, `${indent}  `));
        }
    }
    return lines;
}

export async function list(dirPath = '.', options: ListOptions = {}): Promise<string> {
    const sandbox = sandboxRoot();
    const targetPath = resolveAccessPath(dirPath, sandbox, options);
    const external = !isInsidePath(sandbox, targetPath);
    const root = external ? targetPath : sandbox;
    const stats = await fsp.stat(targetPath);
    if (!stats.isDirectory()) {
        throw new Error(`${dirPath} is not a directory`);
    }

    const depth = Math.max(1, Math.floor(options.depth ?? DEFAULT_LIST_DEPTH));
    const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_LIST_ENTRIES));
    const files = options.includeIgnored
        ? await fsFiles(targetPath, root, depth, true)
        : (await rgFiles(root, targetPath, false)) ?? await fsFiles(targetPath, root, depth, false);

    const targetRel = path.relative(root, targetPath).split(path.sep).join('/');
    const tree = makeTreeNode(path.basename(targetPath), targetRel, true);
    for (const file of files) {
        const relToTarget = targetRel && targetRel !== '.' && file.startsWith(`${targetRel}/`)
            ? file.slice(targetRel.length + 1)
            : targetRel && targetRel !== '.'
                ? file
                : file;
        if (!relToTarget || relToTarget === '.') continue;
        const depthOfEntry = relToTarget.split('/').filter(Boolean).length;
        if (depthOfEntry > depth) continue;
        const absolute = path.resolve(root, file);
        const fileStats = await fsp.stat(absolute).catch(() => null);
        addPathToTree(tree, relToTarget, !!fileStats?.isFile(), fileStats?.isFile() ? fileStats.size : undefined);
    }

    const state = { count: 0, truncated: false };
    const rendered = renderTree(tree, { includeSizes: options.includeSizes === true, maxEntries }, state);
    const header = external
        ? `${targetPath.split(path.sep).join('/').replace(/\/?$/, '/')}`
        : `${toDisplayPath(targetPath, root).replace(/\/?$/, '/')}`;
    const suffix = state.truncated ? `\n[truncated after ${maxEntries} entries]` : '';
    return `${header}\n${rendered.map((line) => `  ${line}`).join('\n')}${suffix}`.trimEnd();
}

function normalizeReplacementForEol(value: string, eol: string): string {
    return eol === '\r\n' ? value.replace(/\r?\n/g, '\r\n') : value.replace(/\r\n/g, '\n');
}

function dominantEol(content: string): string {
    const crlf = (content.match(/\r\n/g) || []).length;
    const lf = (content.match(/(?<!\r)\n/g) || []).length;
    return crlf > lf ? '\r\n' : '\n';
}

function countOccurrences(haystack: string, needle: string): number {
    if (needle.length === 0) {
        throw new Error('edit.old must not be empty');
    }
    let count = 0;
    let index = 0;
    while ((index = haystack.indexOf(needle, index)) !== -1) {
        count++;
        index += needle.length;
    }
    return count;
}

function replaceOccurrence(haystack: string, needle: string, replacement: string, occurrence: number): string {
    let seen = 0;
    let searchFrom = 0;
    for (;;) {
        const index = haystack.indexOf(needle, searchFrom);
        if (index === -1) {
            return haystack;
        }
        seen++;
        if (seen === occurrence) {
            return `${haystack.slice(0, index)}${replacement}${haystack.slice(index + needle.length)}`;
        }
        searchFrom = index + needle.length;
    }
}

export async function write(filePath: string, fullContents: string, options?: ExternalAccessOptions): Promise<string> {
    const targetPath = resolveAccessPath(filePath, sandboxRoot(), options);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, String(fullContents), 'utf-8');
    return `Wrote ${toDisplayPath(targetPath)}.`;
}

export async function edit(filePath: string, edits: EditOperation[], options?: ExternalAccessOptions): Promise<string> {
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new Error('files.edit requires a non-empty edits array');
    }

    const targetPath = resolveAccessPath(filePath, sandboxRoot(), options);
    const original = await fsp.readFile(targetPath, 'utf-8');
    const eol = dominantEol(original);
    let next = original;

    for (let index = 0; index < edits.length; index++) {
        const edit = edits[index]!;
        const oldText = normalizeReplacementForEol(String(edit.old ?? ''), eol);
        const newText = normalizeReplacementForEol(String(edit.new ?? ''), eol);
        const occurrences = countOccurrences(next, oldText);

        if (occurrences === 0) {
            throw new Error(`Edit #${index + 1} failed: old text was not found`);
        }

        if (edit.replaceAll) {
            next = next.split(oldText).join(newText);
            continue;
        }

        if (edit.occurrence !== undefined) {
            const occurrence = Math.floor(edit.occurrence);
            if (occurrence < 1 || occurrence > occurrences) {
                throw new Error(`Edit #${index + 1} failed: occurrence ${occurrence} is outside 1..${occurrences}`);
            }
            next = replaceOccurrence(next, oldText, newText, occurrence);
            continue;
        }

        if (occurrences > 1) {
            throw new Error(`Edit #${index + 1} failed: old text appears ${occurrences} times; specify replaceAll or occurrence`);
        }

        next = next.replace(oldText, newText);
    }

    await fsp.writeFile(targetPath, next, 'utf-8');
    return `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${toDisplayPath(targetPath)}.`;
}

export default {
    read,
    search,
    list,
    write,
    edit,
};
