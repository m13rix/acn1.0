import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPhrasesFromConstituency, extractPhrasesFromDependencies } from '../src/memory_system/phrases.ts';

test('constituency extraction keeps leaf-level NP/VP/ADJP material and prunes nested NP/VP/ADJP/PP branches', () => {
  const tree = [
    '(ROOT',
    '  (S',
    '    (NP (DT The) (NN scientist))',
    '    (VP',
    '      (VBD tried)',
    '      (VP (TO to) (VP (VB open) (NP (DT the) (NN device))))',
    '      (PP (IN with) (NP (DT a) (NN key))))',
    '    (ADJP (RB very) (JJ careful))',
    '  )',
    ')',
  ].join(' ');

  const phrases = extractPhrasesFromConstituency(tree);
  assert.deepEqual(phrases.np, ['The scientist', 'the device', 'a key']);
  assert.ok(phrases.vp.includes('tried to open'));
  assert.ok(phrases.vp.includes('to open'));
  assert.ok(phrases.vp.includes('open'));
  assert.deepEqual(phrases.adjp, ['very careful']);
  assert.ok(!phrases.vp.some((phrase) => phrase.includes('device')));
  assert.ok(!phrases.vp.some((phrase) => phrase.includes('key')));
});

test('dependency extraction uses UD fallback and prunes prepositional branches from VP phrases', () => {
  const phrases = extractPhrasesFromDependencies([
    { id: 1, text: 'Subject', lemma: 'subject', upos: 'NOUN', xpos: 'NN', head: 2, deprel: 'nsubj' },
    { id: 2, text: 'moved', lemma: 'move', upos: 'VERB', xpos: 'VBD', head: 0, deprel: 'root' },
    { id: 3, text: 'to', lemma: 'to', upos: 'ADP', xpos: 'IN', head: 4, deprel: 'case' },
    { id: 4, text: 'Berlin', lemma: 'Berlin', upos: 'PROPN', xpos: 'NNP', head: 2, deprel: 'obl' },
    { id: 5, text: 'young', lemma: 'young', upos: 'ADJ', xpos: 'JJ', head: 2, deprel: 'xcomp' },
  ]);

  assert.deepEqual(phrases.np, ['Subject', 'Berlin']);
  assert.deepEqual(phrases.vp, ['moved']);
  assert.deepEqual(phrases.adjp, ['young']);
});
