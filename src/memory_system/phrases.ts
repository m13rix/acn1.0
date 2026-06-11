import type { StanzaDependencyWord, StanzaSentenceAnnotation } from './stanzaRuntime.js';

export type PhraseType = 'np' | 'vp' | 'adjp';
export type ParserMode = 'constituency' | 'ud';

export interface ConstituencyTreeNode {
  label: string;
  children: ConstituencyTreeNode[];
  token?: string;
}

export interface ExtractedPhraseSet {
  np: string[];
  vp: string[];
  adjp: string[];
}

export interface WeightedQueryPhrase {
  type: PhraseType;
  text: string;
  weight: number;
}

const CONSTITUENCY_TARGETS = new Map<string, PhraseType>([
  ['NP', 'np'],
  ['VP', 'vp'],
  ['ADJP', 'adjp'],
]);
const CONSTITUENCY_PRUNE_LABELS = new Set(['NP', 'ADJP', 'PP']);
const UD_NP_POS = new Set(['NOUN', 'PROPN', 'PRON']);
const UD_VP_POS = new Set(['VERB', 'AUX']);
const UD_ADJP_POS = new Set(['ADJ']);
const CLOSING_PUNCTUATION = /^[,.;:!?%)\]}]+$/;
const OPENING_PUNCTUATION = /^[(\[{]+$/;

function createEmptyPhraseSet(): ExtractedPhraseSet {
  return {
    np: [],
    vp: [],
    adjp: [],
  };
}

function normalizePhraseText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]}])/g, '$1')
    .replace(/([(\[{])\s+/g, '$1')
    .replace(/\s+((?:'|\u2019)s)\b/g, '$1')
    .trim();
}

function joinSurfaceTokens(tokens: string[]): string {
  if (tokens.length === 0) {
    return '';
  }

  let text = '';
  for (const token of tokens) {
    if (!token) continue;
    if (!text) {
      text = token;
      continue;
    }
    if (CLOSING_PUNCTUATION.test(token)) {
      text += token;
      continue;
    }
    if (OPENING_PUNCTUATION.test(token)) {
      text += ` ${token}`;
      continue;
    }
    text += ` ${token}`;
  }

  return normalizePhraseText(text);
}

function getPhraseBucket(phrases: ExtractedPhraseSet, type: PhraseType): string[] {
  switch (type) {
    case 'np':
      return phrases.np;
    case 'vp':
      return phrases.vp;
    case 'adjp':
      return phrases.adjp;
  }
}

function addPhrase(phrases: ExtractedPhraseSet, type: PhraseType, text: string): void {
  const normalized = normalizePhraseText(text);
  if (!normalized) return;
  const bucket = getPhraseBucket(phrases, type);
  if (!bucket.includes(normalized)) {
    bucket.push(normalized);
  }
}

export function parseConstituencyTree(input: string): ConstituencyTreeNode {
  const tokens = input.match(/\(|\)|[^\s()]+/g) ?? [];
  let index = 0;

  function parseNode(): ConstituencyTreeNode {
    const open = tokens[index];
    if (open !== '(') {
      throw new Error(`Expected "(" at token ${index}, received "${open ?? 'EOF'}".`);
    }
    index += 1;

    const label = tokens[index];
    if (!label || label === '(' || label === ')') {
      throw new Error(`Expected tree label at token ${index}, received "${label ?? 'EOF'}".`);
    }
    index += 1;

    const children: ConstituencyTreeNode[] = [];
    while (index < tokens.length && tokens[index] !== ')') {
      const next = tokens[index];
      if (next === '(') {
        children.push(parseNode());
        continue;
      }
      children.push({
        label: next ?? '',
        children: [],
        token: next ?? '',
      });
      index += 1;
    }

    if (tokens[index] !== ')') {
      throw new Error(`Expected ")" at token ${index}.`);
    }
    index += 1;

    return {
      label,
      children,
    };
  }

  const root = parseNode();
  if (index !== tokens.length) {
    throw new Error('Unexpected trailing tokens in constituency tree.');
  }
  return root;
}

function collectConstituencyTokens(node: ConstituencyTreeNode): string[] {
  if (node.token) {
    return [node.token];
  }

  const tokens: string[] = [];
  for (const child of node.children) {
    if (CONSTITUENCY_PRUNE_LABELS.has(child.label)) {
      continue;
    }
    tokens.push(...collectConstituencyTokens(child));
  }
  return tokens;
}

function visitConstituency(node: ConstituencyTreeNode, phrases: ExtractedPhraseSet): void {
  const type = CONSTITUENCY_TARGETS.get(node.label);
  if (type) {
    const tokens = collectConstituencyTokens(node);
    const text = joinSurfaceTokens(tokens);
    if (text) {
      addPhrase(phrases, type, text);
    }
  }

  for (const child of node.children) {
    if (!child.token) {
      visitConstituency(child, phrases);
    }
  }
}

export function extractPhrasesFromConstituency(input: string): ExtractedPhraseSet {
  const tree = parseConstituencyTree(input);
  const phrases = createEmptyPhraseSet();
  visitConstituency(tree, phrases);
  return phrases;
}

function getUdPhraseType(word: StanzaDependencyWord): PhraseType | null {
  const upos = word.upos ?? '';
  if (UD_NP_POS.has(upos)) return 'np';
  if (UD_VP_POS.has(upos)) return 'vp';
  if (UD_ADJP_POS.has(upos)) return 'adjp';
  return null;
}

function buildChildrenMap(words: StanzaDependencyWord[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const word of words) {
    const bucket = out.get(word.head) ?? [];
    bucket.push(word.id);
    out.set(word.head, bucket);
  }
  for (const bucket of out.values()) {
    bucket.sort((a, b) => a - b);
  }
  return out;
}

function subtreeContainsCaseMarker(
  wordId: number,
  wordsById: Map<number, StanzaDependencyWord>,
  childrenByHead: Map<number, number[]>,
): boolean {
  const word = wordsById.get(wordId);
  if (!word) return false;
  if (word.upos === 'ADP' || word.deprel === 'case') {
    return true;
  }
  for (const childId of childrenByHead.get(wordId) ?? []) {
    if (subtreeContainsCaseMarker(childId, wordsById, childrenByHead)) {
      return true;
    }
  }
  return false;
}

function isUdPrepositionalSubtree(
  wordId: number,
  rootId: number,
  wordsById: Map<number, StanzaDependencyWord>,
  childrenByHead: Map<number, number[]>,
): boolean {
  if (wordId === rootId) return false;
  const word = wordsById.get(wordId);
  if (!word) return false;
  if (word.upos === 'ADP' || word.deprel === 'case') {
    return true;
  }
  const deprel = word.deprel ?? '';
  if (deprel === 'obl' || deprel === 'nmod') {
    return subtreeContainsCaseMarker(wordId, wordsById, childrenByHead);
  }
  return false;
}

function collectUdWordIds(
  wordId: number,
  rootId: number,
  wordsById: Map<number, StanzaDependencyWord>,
  childrenByHead: Map<number, number[]>,
): number[] {
  const word = wordsById.get(wordId);
  if (!word) return [];
  if (wordId !== rootId && getUdPhraseType(word)) {
    return [];
  }
  if (isUdPrepositionalSubtree(wordId, rootId, wordsById, childrenByHead)) {
    return [];
  }

  const ids: number[] = [];
  if (word.upos !== 'PUNCT') {
    ids.push(word.id);
  }
  for (const childId of childrenByHead.get(wordId) ?? []) {
    ids.push(...collectUdWordIds(childId, rootId, wordsById, childrenByHead));
  }
  return ids;
}

export function extractPhrasesFromDependencies(words: StanzaDependencyWord[]): ExtractedPhraseSet {
  const phrases = createEmptyPhraseSet();
  const wordsById = new Map(words.map(word => [word.id, word]));
  const childrenByHead = buildChildrenMap(words);

  for (const word of words) {
    const type = getUdPhraseType(word);
    if (!type) continue;
    const ids = collectUdWordIds(word.id, word.id, wordsById, childrenByHead)
      .sort((a, b) => a - b);
    const tokens = ids
      .map(id => wordsById.get(id)?.text ?? '')
      .filter(Boolean);
    const text = joinSurfaceTokens(tokens);
    if (text) {
      addPhrase(phrases, type, text);
    }
  }

  return phrases;
}

export function extractSentencePhrases(sentence: StanzaSentenceAnnotation, parserMode: ParserMode): ExtractedPhraseSet {
  if (parserMode === 'constituency' && sentence.constituency) {
    return extractPhrasesFromConstituency(sentence.constituency);
  }
  return extractPhrasesFromDependencies(sentence.dependencies);
}

export function mergePhraseSets(sets: ExtractedPhraseSet[]): ExtractedPhraseSet {
  const merged = createEmptyPhraseSet();
  for (const set of sets) {
    for (const phrase of set.np) addPhrase(merged, 'np', phrase);
    for (const phrase of set.vp) addPhrase(merged, 'vp', phrase);
    for (const phrase of set.adjp) addPhrase(merged, 'adjp', phrase);
  }
  return merged;
}

export function flattenPhraseSet(phrases: ExtractedPhraseSet): Array<{ type: PhraseType; text: string }> {
  return [
    ...phrases.np.map(text => ({ type: 'np' as const, text })),
    ...phrases.vp.map(text => ({ type: 'vp' as const, text })),
    ...phrases.adjp.map(text => ({ type: 'adjp' as const, text })),
  ];
}
