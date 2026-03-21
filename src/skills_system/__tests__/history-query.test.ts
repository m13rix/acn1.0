import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillsService } from '../SkillsService.js';

test('buildHistorySearchQuery includes user, assistant, tool, and file history', () => {
  const query = SkillsService.buildHistorySearchQuery([
    { role: 'user', content: 'Please debug the build.' },
    { role: 'assistant', content: 'I will inspect the failing command next.' },
    { role: 'tool', content: 'npm ERR! command failed', toolName: 'cli' },
    { role: 'file', content: 'package.json contents', filename: 'package.json' },
  ]);

  assert.match(query, /\[USER\] Please debug the build\./);
  assert.match(query, /\[ASSISTANT\] I will inspect the failing command next\./);
  assert.match(query, /\[TOOL:cli\] npm ERR! command failed/);
  assert.match(query, /\[FILE \(package\.json\)\] package\.json contents/);
});
