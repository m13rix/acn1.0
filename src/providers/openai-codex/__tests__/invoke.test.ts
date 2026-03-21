import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message, ProviderConfig } from '../../../types/index.js';
import { buildCodexRequest } from '../invoke.js';

const BASE_CONFIG: ProviderConfig = {
  model: 'openai-codex/gpt-5-codex',
  reasoning: 'medium',
};

function getInput(messages: Message[]): Array<Record<string, unknown>> {
  const request = buildCodexRequest(messages, BASE_CONFIG);
  return (request.input as Array<Record<string, unknown>>) || [];
}

test('maps image file messages to input_image content', () => {
  const base64Image =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO8B9l8AAAAASUVORK5CYII=';
  const input = getInput([
    { role: 'system', content: 'Be helpful.' },
    { role: 'user', content: 'What is in this screenshot?' },
    { role: 'file', filename: 'screenshot.png', content: base64Image },
  ]);

  assert.equal(input.length, 2);
  assert.deepEqual(input[1], {
    role: 'user',
    content: [{
      type: 'input_image',
      image_url: `data:image/png;base64,${base64Image}`,
    }],
  });
});

test('decodes base64 text file messages into input_text observations', () => {
  const fileText = 'export const answer = 42;\n';
  const input = getInput([
    { role: 'user', content: 'Review this file.' },
    {
      role: 'file',
      filename: 'answer.ts',
      content: Buffer.from(fileText, 'utf-8').toString('base64'),
    },
  ]);

  assert.equal(input.length, 2);
  assert.deepEqual(input[1], {
    role: 'user',
    content: [{
      type: 'input_text',
      text: `<obs>\nanswer.ts:\n${fileText}\n</obs>`,
    }],
  });
});

test('preserves raw text file messages when content is not base64', () => {
  const rawText = 'plain text content';
  const input = getInput([
    { role: 'user', content: 'Review this file.' },
    {
      role: 'file',
      filename: 'notes.md',
      content: rawText,
    },
  ]);

  assert.equal(input.length, 2);
  assert.deepEqual(input[1], {
    role: 'user',
    content: [{
      type: 'input_text',
      text: `<obs>\nnotes.md:\n${rawText}\n</obs>`,
    }],
  });
});

test('maps binary file messages to input_file content', () => {
  const base64Pdf = 'JVBERi0xLjQK';
  const input = getInput([
    { role: 'user', content: 'Summarize this PDF.' },
    {
      role: 'file',
      filename: 'document.pdf',
      content: base64Pdf,
    },
  ]);

  assert.equal(input.length, 2);
  assert.deepEqual(input[1], {
    role: 'user',
    content: [{
      type: 'input_file',
      filename: 'document.pdf',
      file_data: base64Pdf,
    }],
  });
});
