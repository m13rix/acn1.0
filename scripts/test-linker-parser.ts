import assert from 'node:assert/strict';
import { parseLinkerRawResponse } from '../src/memory_system/linker.ts';

interface Case {
  name: string;
  input: string;
  expectedRows: number;
}

const cases: Case[] = [
  {
    name: 'toon basic',
    input: [
      'links[1,]{fromFactId,toFactId,relation,confidence}:',
      'a,b,CAUSES,0.8',
    ].join('\n'),
    expectedRows: 1,
  },
  {
    name: 'toon fenced with two rows',
    input: [
      '```toon',
      'links[2,]{fromFactId,toFactId,relation,confidence}:',
      'a,b,CAUSES,0.9',
      'b,c,CONTRASTS_WITH,0.7',
      '```',
    ].join('\n'),
    expectedRows: 2,
  },
  {
    name: 'toon with inferred row count',
    input: [
      'links[,]{fromFactId,toFactId,relation,confidence}:',
      'a,b,CAUSES,0.9',
      'b,c,SUPPORTS,0.6',
    ].join('\n'),
    expectedRows: 2,
  },
  {
    name: 'toon object rows',
    input: [
      'links[1,]{fromFactId,toFactId,relation,confidence}:',
      '{"fromFactId":"x","toFactId":"y","relation":"EXPLAINS","confidence":0.5}',
    ].join('\n'),
    expectedRows: 1,
  },
  {
    name: 'json object fallback',
    input: JSON.stringify({
      links: [{ fromFactId: 'a', toFactId: 'b', relation: 'CAUSES', confidence: 0.8 }],
    }),
    expectedRows: 1,
  },
  {
    name: 'json array fallback',
    input: JSON.stringify([{ fromFactId: 'a', toFactId: 'b', relation: 'CAUSES', confidence: 0.8 }]),
    expectedRows: 1,
  },
  {
    name: 'quoted empty string',
    input: '""',
    expectedRows: 0,
  },
  {
    name: 'zero links shorthand comma',
    input: 'links[0,]',
    expectedRows: 0,
  },
  {
    name: 'zero links shorthand plain',
    input: 'links[0]',
    expectedRows: 0,
  },
  {
    name: 'zero links without columns but with colon',
    input: 'links[0,]:',
    expectedRows: 0,
  },
  {
    name: 'blank output',
    input: '   ',
    expectedRows: 0,
  },
];

for (const testCase of cases) {
  const rows = parseLinkerRawResponse(testCase.input);
  assert.equal(rows.length, testCase.expectedRows, `${testCase.name}: expected ${testCase.expectedRows} rows, got ${rows.length}`);
}

assert.throws(() => parseLinkerRawResponse('completely malformed response without toon or json'), /TOON|JSON|object/i);

console.log(`OK: ${cases.length + 1} parser cases passed`);
