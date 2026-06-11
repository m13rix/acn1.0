import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type {
  ImportedOriginalMetadata,
  ImportedSource,
  ImportInspectionDraft,
  ImportRiskReport,
  NormalizedMethodSpec,
} from '../types/index.js';
import { deriveMethodName, deriveNamespace, toSafeSlug } from './naming.js';
import { inferDisplayName, resolveImportedSource } from './sourceResolver.js';
import { fileExists, isPlainObject } from './utils.js';

interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(content: string): ParsedSkill {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  return {
    frontmatter: (parseYaml(normalized.slice(4, endIndex)) as Record<string, unknown>) || {},
    body: normalized.slice(endIndex + 5),
  };
}

function extractShellBlocks(content: string): string[] {
  const matches = Array.from(content.matchAll(/```(?:bash|sh|shell)?\s*([\s\S]*?)```/gi));
  return matches.map((match) => match[1]?.trim() || '').filter(Boolean);
}

function isUnsafeShell(command: string): boolean {
  return /[|&;`$()><]/.test(command);
}

function tokenizeCommand(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^['"]|['"]$/g, '')) || [];
}

function optionNameFromToken(token: string): string {
  const words = token.replace(/^--?/, '').replace(/[<>]/g, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((part, index) => {
    const lower = part.toLowerCase();
    return index === 0 ? lower : lower[0]!.toUpperCase() + lower.slice(1);
  }).join('') || 'value';
}

function methodFromCommand(
  command: string,
  namespace: string,
  usedNames: Set<string>,
  declaredBinary: string
): NormalizedMethodSpec | null {
  if (isUnsafeShell(command)) return null;
  const tokens = tokenizeCommand(command);
  if (tokens.length < 2 || tokens[0] !== declaredBinary) return null;

  const segments: string[] = [];
  const parameters: NormalizedMethodSpec['parameters'] = [];
  const options: NonNullable<Extract<NormalizedMethodSpec['invocation'], { kind: 'clawhub' }>>['options'] = [];

  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.startsWith('--')) {
      const next = tokens[index + 1];
      if (next && !next.startsWith('-')) {
        const name = optionNameFromToken(token);
        parameters.push({ name, required: false, location: 'option', token });
        options.push({ name, kind: 'option', token, required: false });
        index += 2;
        continue;
      }
      const name = optionNameFromToken(token);
      parameters.push({ name, required: false, location: 'flag', token });
      options.push({ name, kind: 'flag', token, required: false });
      index += 1;
      continue;
    }
    if (/^<.+>$/.test(token)) {
      const name = optionNameFromToken(token);
      parameters.push({ name, required: true, location: 'positional', token });
      options.push({ name, kind: 'positional', token, required: true });
      index += 1;
      continue;
    }
    if (parameters.length === 0) {
      segments.push(token);
    } else {
      const name = `arg${parameters.length + 1}`;
      parameters.push({ name, required: true, location: 'positional', token });
      options.push({ name, kind: 'positional', token, required: true });
    }
    index += 1;
  }

  if (segments.length === 0) return null;

  const methodName = deriveMethodName(segments.join('_'), namespace, usedNames);
  usedNames.add(methodName);
  return {
    originalName: command,
    methodName,
    description: `Imported command wrapper for \`${command}\`.`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, { type: 'string' }])),
      required: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    },
    outputSchema: undefined,
    parameters,
    orderedParameters: parameters.map((parameter) => parameter.name),
    positionalOverload: parameters.length <= 3,
    invocation: {
      kind: 'clawhub',
      binary: declaredBinary,
      segments,
      options,
      smokeCommand: [declaredBinary, ...segments, '--help'],
    },
  };
}

function buildRiskReport(parsedSkill: ParsedSkill, methods: NormalizedMethodSpec[], blocks: string[], binary: string | null): ImportRiskReport {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const inferred: string[] = [];

  if (!binary) blockers.push('Skill frontmatter must declare at least one runtime binary in requires.bins.');
  if (blocks.length === 0) blockers.push('SKILL.md does not contain shell examples to extract commands from.');
  if (methods.length === 0) blockers.push('No safe executable command family could be extracted from SKILL.md.');
  if (methods.some((method) => method.parameters.length === 0)) {
    warnings.push('One or more commands were imported without typed parameters.');
  }
  if (!parsedSkill.frontmatter.description) {
    inferred.push('Skill description is missing; TELOS docs will be synthesized.');
  }

  return { warnings, blockers, inferred };
}

export async function inspectClawhubImport(options: {
  source: ImportedSource;
  existingToolNames?: string[];
}): Promise<ImportInspectionDraft> {
  const resolved = await resolveImportedSource(options.source);
  try {
    const skillPath = join(resolved.sourceRoot, 'SKILL.md');
    if (!await fileExists(skillPath)) {
      throw new Error('The selected ClawHub source does not contain SKILL.md.');
    }
    const rawSkill = await readFile(skillPath, 'utf8');
    const parsedSkill = parseFrontmatter(rawSkill);
    const requires = isPlainObject(parsedSkill.frontmatter['requires'])
      ? parsedSkill.frontmatter['requires'] as Record<string, unknown>
      : {};
    const bins = Array.isArray(requires['bins']) ? requires['bins'].map(String) : [];
    const binary = bins[0] || null;

    const displayName = options.source.displayName || inferDisplayName(options.source);
    const namespace = deriveNamespace(displayName, options.existingToolNames);
    const slug = toSafeSlug(displayName);
    const blocks = extractShellBlocks(rawSkill);
    const commands = blocks.flatMap((block) => block.split('\n').map((line) => line.trim()).filter(Boolean));
    const usedNames = new Set<string>();
    const methods = binary
      ? commands
        .map((command) => methodFromCommand(command, namespace, usedNames, binary))
        .filter((value): value is NormalizedMethodSpec => Boolean(value))
      : [];

    const risk = buildRiskReport(parsedSkill, methods, blocks, binary);
    const original: ImportedOriginalMetadata = { skill: rawSkill };

    return {
      kind: 'clawhub',
      slug,
      namespace,
      displayName,
      knowledgeMode: 'description',
      description: typeof parsedSkill.frontmatter.description === 'string'
        ? parsedSkill.frontmatter.description
        : `${displayName} imported ClawHub namespace.`,
      source: options.source,
      runtime: resolved.runtime,
      methods,
      risk,
      docs: {
        toolDescription: '',
        usageMarkdown: '',
        methodDocs: {},
        sources: [
          { name: 'SKILL.md', kind: 'skill' },
          { name: 'command-inspection', kind: 'inspection' },
        ],
        generatedWith: '',
      },
      original,
    };
  } finally {
    await resolved.cleanup().catch(() => {});
  }
}
