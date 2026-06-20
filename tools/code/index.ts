/**
 * Code system package.
 *
 * Automatically injected into every LocalSandbox action as `code`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import ts from 'typescript';

function sandboxRoot(): string {
    return path.resolve(process.env.SANDBOX_DIR || process.cwd());
}

function resolveInsideSandbox(inputPath: string): string {
    if (typeof inputPath !== 'string' || inputPath.trim().length === 0) {
        throw new Error('path must be a non-empty string');
    }

    const root = sandboxRoot();
    const target = path.resolve(root, inputPath);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Security Error: path resolves outside sandbox: ${inputPath}`);
    }
    return target;
}

function displayPath(absolutePath: string): string {
    return (path.relative(sandboxRoot(), absolutePath) || '.').split(path.sep).join('/');
}

function scriptKindFor(filePath: string): ts.ScriptKind {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.tsx') return ts.ScriptKind.TSX;
    if (ext === '.jsx') return ts.ScriptKind.JSX;
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
}

function lineRange(source: ts.SourceFile, node: ts.Node): string {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    return `lines ${start}-${end}`;
}

function nodeName(node: ts.Node): string | null {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
        return node.name.text;
    }
    if ((ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) {
        return node.name.getText();
    }
    if (ts.isConstructorDeclaration(node)) {
        return 'constructor';
    }
    if (ts.isVariableStatement(node)) {
        const names = node.declarationList.declarations
            .filter((decl) => decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)))
            .map((decl) => decl.name.getText());
        return names.length > 0 ? names.join(', ') : null;
    }
    return null;
}

function nodeKindLabel(node: ts.Node): string | null {
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isFunctionDeclaration(node)) return 'function';
    if (ts.isMethodDeclaration(node)) return '';
    if (ts.isConstructorDeclaration(node)) return '';
    if (ts.isPropertyDeclaration(node)) return 'property';
    if (ts.isGetAccessorDeclaration(node)) return 'get';
    if (ts.isSetAccessorDeclaration(node)) return 'set';
    if (ts.isTypeAliasDeclaration(node)) return 'type';
    if (ts.isEnumDeclaration(node)) return 'enum';
    if (ts.isVariableStatement(node)) return 'const';
    return null;
}

function collectOutline(source: ts.SourceFile, node: ts.Node, depth: number, lines: string[]): void {
    const label = nodeKindLabel(node);
    const name = nodeName(node);
    if (label !== null && name) {
        const prefix = label ? `${label} ` : '';
        lines.push(`${'  '.repeat(depth)}${prefix}${name} ${lineRange(source, node)}`);
        depth += 1;
    }

    ts.forEachChild(node, (child) => {
        if (depth > 0 || ts.isClassDeclaration(child) || ts.isInterfaceDeclaration(child) || ts.isFunctionDeclaration(child) || ts.isTypeAliasDeclaration(child) || ts.isEnumDeclaration(child) || ts.isVariableStatement(child)) {
            collectOutline(source, child, depth, lines);
        }
    });
}

export async function outline(filePath: string): Promise<string> {
    const targetPath = resolveInsideSandbox(filePath);
    const content = await fs.readFile(targetPath, 'utf-8');
    const source = ts.createSourceFile(
        targetPath,
        content,
        ts.ScriptTarget.Latest,
        true,
        scriptKindFor(targetPath),
    );

    const lines = [`${displayPath(targetPath)}`];
    collectOutline(source, source, 1, lines);
    if (lines.length === 1) {
        lines.push('  (no top-level outline items found)');
    }
    return lines.join('\n');
}

export default {
    outline,
};
