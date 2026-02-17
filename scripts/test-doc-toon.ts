import assert from 'node:assert/strict';
import { parseToonTables } from '../src/memory_system/toon.ts';

const sample = [
  'facts[2,]{id,content}:',
  '0,"[Doc | 2024 | S > A] Fact A"',
  '1,"[Doc | 2024 | S > A] Fact B"',
  'links[1,]{fromId,toId,relation,confidence}:',
  '0,1,ELABORATES,0.9',
].join('\n');

const parsed = parseToonTables(sample, ['facts', 'links']);
assert.equal(parsed.facts?.rows.length, 2);
assert.equal(parsed.links?.rows.length, 1);
assert.equal(String(parsed.facts?.rows[0]?.id), '0');
assert.equal(String(parsed.links?.rows[0]?.relation), 'ELABORATES');

const zeroLinks = parseToonTables(
  ['facts[1,]{id,content}:', '0,One fact', 'links[0,]:'].join('\n'),
  ['facts', 'links']
);
assert.equal(zeroLinks.links?.rows.length, 0);

const repeatedInlineHeaders = parseToonTables(
  [
    'facts[0,]{id,content}:0,"Fact A"',
    'facts[1,]{id,content}:1,"Fact B"',
    'links[0,]{fromId,toId,relation,confidence}:0,1,ELABORATES,0.9',
  ].join('\n'),
  ['facts', 'links']
);
assert.equal(repeatedInlineHeaders.facts?.rows.length, 2);
assert.equal(String(repeatedInlineHeaders.facts?.rows[1]?.content), 'Fact B');
assert.equal(repeatedInlineHeaders.links?.rows.length, 1);

const singularLinkRows = parseToonTables(
  [
    'facts[2,]{id,content}:',
    '0,"Fact A"',
    '1,"Fact B"',
    'link[0,1,CONTINUES,1.0]',
    'link[1,0,CONTRASTS_WITH,0.6]',
  ].join('\n'),
  ['facts', 'links']
);
assert.equal(singularLinkRows.facts?.rows.length, 2);
assert.equal(singularLinkRows.links?.rows.length, 2);
assert.equal(String(singularLinkRows.links?.rows[0]?.fromId), '0');
assert.equal(String(singularLinkRows.links?.rows[0]?.relation), 'CONTINUES');

const symbolicCounts = parseToonTables(
  [
    'facts[N,]{id,content}:',
    '0,"Fact A"',
    '1,"Fact B"',
    'links[M,]{fromId,toId,relation,confidence}:',
    '0,1,CONTINUES,1.0',
  ].join('\n'),
  ['facts', 'links']
);
assert.equal(symbolicCounts.facts?.rows.length, 2);
assert.equal(symbolicCounts.links?.rows.length, 1);

const blockObjectStyle = parseToonTables(
  [
    'facts[0]{',
    'id:0,',
    'content:[Doc] Fact A',
    '}',
    'links[0]{',
    'fromId:0,',
    'toId:0,',
    'relation:SELF,',
    'confidence:0.1',
    '}',
  ].join('\n'),
  ['facts', 'links']
);
assert.equal(blockObjectStyle.facts?.rows.length, 1);
assert.equal(String(blockObjectStyle.facts?.rows[0]?.id), '0');
assert.equal(blockObjectStyle.links?.rows.length, 1);
assert.equal(String(blockObjectStyle.links?.rows[0]?.relation), 'SELF');

const bracketEmbeddedColumns = parseToonTables(
  [
    'facts[2,{id,content}]:',
    '0,"Fact A"',
    '1,"Fact B"',
    'links[1,{fromId,toId,relation,confidence}]:',
    '0,1,CONTINUES,1.0',
  ].join('\n'),
  ['facts', 'links']
);
assert.equal(bracketEmbeddedColumns.facts?.rows.length, 2);
assert.equal(bracketEmbeddedColumns.links?.rows.length, 1);
assert.equal(String(bracketEmbeddedColumns.links?.rows[0]?.relation), 'CONTINUES');

console.log('OK: doc TOON parser cases passed');
