import assert from 'node:assert/strict';
import test from 'node:test';
import { PromptBuilder } from '../src/core/PromptBuilder.ts';
import { getEffectiveMemoryCategories } from '../src/core/memoryToolDocs.ts';
import type { LoadedAgent, LoadedTool } from '../src/types/index.ts';

function makeTool(name: string, description = `${name} docs`): LoadedTool {
  return {
    config: { name, description, module: 'index.ts' },
    directory: `G:\\agent0\\acn1.0\\tools\\${name}`,
    absolutePath: `G:\\agent0\\acn1.0\\tools\\${name}\\index.ts`,
    skillEntries: [],
  };
}

function makeAgent(memoryToolDocs: boolean): LoadedAgent {
  return {
    config: {
      name: 'test-agent',
      model: 'test-model',
      systemPrompt: 'prompts/system.md',
      tools: ['utils', 'search'],
      memoryToolDocs,
      memory: {
        enabled: true,
        categories: [{ name: 'core' }],
      },
    },
    systemPromptContent: 'Base prompt.',
    directory: 'G:\\agent0\\acn1.0\\agents\\test-agent',
  };
}

test('memoryToolDocs adds tooldoc categories for loaded tools', () => {
  const categories = getEffectiveMemoryCategories(makeAgent(true), [
    makeTool('utils'),
    makeTool('search'),
  ]);

  assert.deepEqual(categories?.map((cat) => cat.name), [
    'core',
    'tooldoc_utils',
    'tooldoc_search',
  ]);
});

test('memoryToolDocs keeps full tool docs out of the system prompt', () => {
  const prompt = new PromptBuilder().build(
    makeAgent(true),
    { name: 'test', getDescription: () => '' } as any,
    { name: 'test', getDescription: () => '' } as any,
    [makeTool('utils', 'VERY_LONG_UTILS_DOC'), makeTool('search', 'VERY_LONG_SEARCH_DOC')],
    { getDescription: () => '' } as any
  );

  assert.match(prompt, /Available modules: `utils`, `search`/);
  assert.match(prompt, /utils\.tools\.doc\("name"\)/);
  assert.doesNotMatch(prompt, /VERY_LONG_UTILS_DOC/);
  assert.doesNotMatch(prompt, /VERY_LONG_SEARCH_DOC/);
});
