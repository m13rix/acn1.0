import { rm, writeFile } from 'fs/promises';
import { join } from 'path';
import type { GeneratedDocBundle, GeneratedSkillBundle, ImportedIntegrationManifest, NormalizedMethodSpec } from '../types/index.js';
import {
  IMPORTED_MANIFEST_FILENAME,
  IMPORTED_RUNTIME_MODULE_PATH,
} from './constants.js';
import { schemaToTsType } from './jsonSchema.js';
import { ensureDir, writeJson } from './utils.js';

function renderMethodSignature(method: NormalizedMethodSpec): string {
  const objectType = schemaToTsType(method.inputSchema);
  if (!method.positionalOverload || method.parameters.length === 0) {
    return `export async function ${method.methodName}(input: ${objectType} = {} as ${objectType}): Promise<unknown>`;
  }

  const firstType = schemaToTsType(method.parameters[0]?.schema as Record<string, unknown> | undefined);
  const rest = method.parameters.slice(1)
    .map((parameter) => `${parameter.name}${parameter.required ? '' : '?'}: ${schemaToTsType(parameter.schema as Record<string, unknown> | undefined)}`)
    .join(', ');
  const suffix = rest ? `, ${rest}` : '';
  return `export async function ${method.methodName}(inputOrFirst: ${objectType} | ${firstType} = {} as ${objectType}${suffix}): Promise<unknown>`;
}

function renderMethodBody(method: NormalizedMethodSpec): string {
  const normalizePositional = method.positionalOverload && method.parameters.length > 0
    ? [
      '  const input = isImportedInputObject(inputOrFirst)',
      '    ? inputOrFirst',
      '    : {',
      ...method.parameters.map((parameter, index) => `        ${JSON.stringify(parameter.name)}: ${index === 0 ? 'inputOrFirst' : parameter.name},`),
      '      };',
    ].join('\n')
    : '  const normalizedInput = isImportedInputObject(input) ? input : {};';

  return [
    `/** ${(method.description || 'Imported method.').replace(/\*\//g, '* /')} */`,
    `${renderMethodSignature(method)} {`,
    normalizePositional,
    `  return invokeImportedMethod(new URL('./${IMPORTED_MANIFEST_FILENAME}', import.meta.url), ${JSON.stringify(method.methodName)}, ${method.positionalOverload && method.parameters.length > 0 ? 'input' : 'normalizedInput'});`,
    '}',
  ].join('\n');
}

function buildToolDescription(manifest: ImportedIntegrationManifest): string {
  if (manifest.knowledgeMode === 'skills') {
    return `${manifest.displayName} imported ${manifest.kind === 'mcp' ? 'MCP' : 'ClawHub'} namespace. Detailed usage guidance is stored in embedded tool skills.`;
  }

  return [
    manifest.docs.toolDescription.trim(),
    '',
    'Available functions:',
    ...manifest.methods.map((method) => `- \`${manifest.namespace}.${method.methodName}(...)\` - ${manifest.docs.methodDocs[method.methodName] || method.description || 'Imported method.'}`),
  ].filter(Boolean).join('\n');
}

function buildSkillsYaml(manifest: ImportedIntegrationManifest): string[] {
  if (!manifest.skills || manifest.knowledgeMode === 'description') {
    return [];
  }

  return [
    'skills:',
    '  enabled: true',
    '  directory: skills',
  ];
}

function skillFileName(index: number, entry: GeneratedSkillBundle['entries'][number]): string {
  const slug = entry.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `entry-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${slug}.json`;
}

function renderIndex(manifest: ImportedIntegrationManifest): string {
  return [
    `import { invokeImportedMethod, isImportedInputObject } from '${IMPORTED_RUNTIME_MODULE_PATH}';`,
    '',
    ...manifest.methods.map((method) => renderMethodBody(method)),
    '',
  ].join('\n\n');
}

export async function writeGeneratedTool(manifest: ImportedIntegrationManifest, toolDir: string): Promise<void> {
  await ensureDir(toolDir);
  await ensureDir(join(toolDir, 'docs'));
  if (manifest.skills && manifest.knowledgeMode !== 'description') {
    await rm(join(toolDir, 'skills'), { recursive: true, force: true });
    await ensureDir(join(toolDir, 'skills'));
  }

  const toolYaml = [
    `name: ${manifest.namespace}`,
    'description: |',
    ...buildToolDescription(manifest)
      .split('\n')
      .map((line) => `  ${line}`),
    'module: index.ts',
    ...buildSkillsYaml(manifest),
  ].join('\n');

  await writeFile(join(toolDir, 'tool.yaml'), `${toolYaml}\n`, 'utf8');
  await writeFile(join(toolDir, 'index.ts'), renderIndex(manifest), 'utf8');
  await writeFile(join(toolDir, 'docs', 'usage.md'), `${manifest.docs.usageMarkdown}\n`, 'utf8');
  if (manifest.skills && manifest.knowledgeMode !== 'description') {
    for (let index = 0; index < manifest.skills.entries.length; index += 1) {
      const entry = manifest.skills.entries[index]!;
      await writeFile(
        join(toolDir, 'skills', skillFileName(index, entry)),
        `${JSON.stringify(entry, null, 2)}\n`,
        'utf8'
      );
    }
  }
  await writeJson(join(toolDir, IMPORTED_MANIFEST_FILENAME), manifest);
}
