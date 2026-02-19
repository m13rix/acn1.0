import { BUILTIN_IDENTIFIER_TO_MODULE } from './constants.js';
import { classifyActionError } from './error-classifier.js';

export interface DeterministicFixInput {
  code: string;
  errorText: string;
  installedPackages: Set<string>;
}

export interface DeterministicFixOutput {
  code: string;
  notes: string[];
  packageToInstall?: string;
  didChange: boolean;
}

export function applyDeterministicFixes(input: DeterministicFixInput): DeterministicFixOutput {
  let code = input.code;
  const notes: string[] = [];
  let didChange = false;

  const strippedFences = stripMarkdownFences(code);
  if (strippedFences !== code) {
    code = strippedFences;
    didChange = true;
    notes.push('removed markdown code fences');
  }

  const normalizedQuotes = normalizeSmartQuotes(code);
  if (normalizedQuotes !== code) {
    code = normalizedQuotes;
    didChange = true;
    notes.push('normalized smart quotes');
  }

  const classification = classifyActionError(input.errorText);
  const missingIdentifier = classification.missingIdentifier;
  if (missingIdentifier) {
    const moduleName = resolveBuiltinModule(missingIdentifier);
    if (moduleName && !hasIdentifierBinding(code, missingIdentifier, moduleName)) {
      code = injectRequireAtTop(code, missingIdentifier, moduleName);
      didChange = true;
      notes.push(`injected require('${moduleName}') for "${missingIdentifier}"`);
    }
  }

  if (classification.hasSyntaxError) {
    const repairedSyntax = repairObviousSyntaxIssues(
      code,
      classification.hasUnterminatedString,
      classification.hasUnexpectedEnd || classification.hasSyntaxError
    );
    if (repairedSyntax !== code) {
      code = repairedSyntax;
      didChange = true;
      notes.push('applied conservative syntax balancing');
    }
  }

  let packageToInstall: string | undefined;
  if (classification.missingPackage) {
    const normalizedPackage = normalizePackageSpecifier(classification.missingPackage);
    if (
      normalizedPackage
      && isInstallablePackageName(normalizedPackage)
      && !input.installedPackages.has(normalizedPackage)
    ) {
      packageToInstall = normalizedPackage;
      notes.push(`detected missing package "${normalizedPackage}"`);
    }
  }

  return {
    code,
    notes,
    packageToInstall,
    didChange,
  };
}

export function stripMarkdownFences(input: string): string {
  const trimmed = input.trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced?.[1]) {
    return fenced[1];
  }
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\r?\n?/, '').replace(/\r?\n?```$/, '');
  }
  return input;
}

export function normalizeSmartQuotes(input: string): string {
  return input
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u0060\u00B4]/g, '`');
}

export function normalizePackageSpecifier(rawPackage: string): string | undefined {
  const pkg = rawPackage.trim();
  if (!pkg) return undefined;
  if (pkg.startsWith('./') || pkg.startsWith('../') || pkg.startsWith('/') || pkg.startsWith('file:')) return undefined;
  if (pkg.startsWith('node:')) return undefined;
  if (pkg.includes('\\') || pkg.includes('://')) return undefined;

  if (pkg.startsWith('@')) {
    const segments = pkg.split('/');
    if (segments.length < 2) return undefined;
    const scope = segments[0];
    const name = segments[1];
    if (!scope || !name) return undefined;
    return `${scope}/${name}`;
  }

  const firstSegment = pkg.split('/')[0];
  return firstSegment || undefined;
}

export function isInstallablePackageName(pkg: string): boolean {
  if (!pkg || pkg.length > 214) return false;
  if (pkg.startsWith('.') || pkg.startsWith('/') || pkg.includes('\\')) return false;
  if (isNodeBuiltinPackage(pkg)) return false;

  const scopedPattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
  const unscopedPattern = /^[a-z0-9][a-z0-9._-]*$/;
  return scopedPattern.test(pkg) || unscopedPattern.test(pkg);
}

function resolveBuiltinModule(identifier: string): string | undefined {
  return BUILTIN_IDENTIFIER_TO_MODULE[identifier] || BUILTIN_IDENTIFIER_TO_MODULE[identifier.toLowerCase()];
}

function hasIdentifierBinding(code: string, identifier: string, moduleName: string): boolean {
  const id = escapeRegExp(identifier);
  const module = escapeRegExp(moduleName);

  const declarationPatterns: RegExp[] = [
    new RegExp(`\\b(?:const|let|var|import)\\s+${id}\\b`),
    new RegExp(`\\b${id}\\s*=\\s*require\\(['"]${module}['"]\\)`),
    new RegExp(`import\\s+\\*\\s+as\\s+${id}\\s+from\\s+['"]${module}['"]`),
    new RegExp(`import\\s+\\{[^}]*\\b${id}\\b[^}]*\\}\\s+from\\s+['"]${module}['"]`),
  ];

  return declarationPatterns.some((pattern) => pattern.test(code));
}

function injectRequireAtTop(code: string, identifier: string, moduleName: string): string {
  const requireLine = `const ${identifier} = require('${moduleName}');`;
  const trimmed = code.trimStart();

  if (trimmed.startsWith('#!')) {
    const lines = code.split('\n');
    const firstLine = lines[0];
    const rest = lines.slice(1).join('\n');
    if (!firstLine) return `${requireLine}\n${code}`;
    return `${firstLine}\n${requireLine}\n${rest}`;
  }

  return `${requireLine}\n${code}`;
}

function repairObviousSyntaxIssues(code: string, closeStrings: boolean, closeDelimiters: boolean): string {
  let result = code;
  if (closeStrings) {
    result = closeUnterminatedString(result);
  }
  if (closeDelimiters) {
    result = closeUnclosedDelimiters(result);
  }
  return result;
}

function closeUnterminatedString(code: string): string {
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (!ch) continue;

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && ch === '`') {
      inTemplate = !inTemplate;
    }
  }

  if (inTemplate) return `${code}\``;
  if (inDouble) return `${code}"`;
  if (inSingle) return `${code}'`;
  return code;
}

function closeUnclosedDelimiters(code: string): string {
  const expectedClosers: string[] = [];

  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];
    if (!ch) continue;

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inSingle || inDouble || inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (inSingle && ch === "'") inSingle = false;
      if (inDouble && ch === '"') inDouble = false;
      if (inTemplate && ch === '`') inTemplate = false;
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      continue;
    }

    if (ch === '{') expectedClosers.push('}');
    if (ch === '[') expectedClosers.push(']');
    if (ch === '(') expectedClosers.push(')');

    if (ch === '}' || ch === ']' || ch === ')') {
      const expected = expectedClosers[expectedClosers.length - 1];
      if (expected === ch) {
        expectedClosers.pop();
      }
    }
  }

  if (expectedClosers.length === 0) {
    return code;
  }

  return `${code}${expectedClosers.reverse().join('')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNodeBuiltinPackage(pkg: string): boolean {
  const normalized = pkg.replace(/^node:/, '');
  return Object.values(BUILTIN_IDENTIFIER_TO_MODULE).includes(normalized);
}

