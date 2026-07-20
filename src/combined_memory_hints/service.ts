import path from 'node:path';
import { getContentMemoryService, type ContentCollection, type StoredContentRow, type StoredContentSentenceRow } from '../content_memory/service.js';
import { embedBatch, cosineSimilarity } from '../memory_system/embeddings.js';
import { analyzeAutoCandidateSelection, selectSeedFacts } from '../memory_system/search.js';
import { getMemoryRuntime } from '../memory_system/runtime.js';
import type {
  CandidateSelectionOptions,
  PhraseAggregationMode,
  QueryPhraseWeightingMode,
  SearchOptions,
  SeedFactScore,
} from '../memory_system/types.js';
import type { WeightedQueryPhrase } from '../memory_system/phrases.js';
import type { LoadedAgent } from '../types/index.js';

export interface HintIdentity {
  id: string;
  name: string;
  description?: string;
}

export interface HintSourceControls {
  weight: number;
  recencyBias?: number;
  candidateSelection: CandidateSelectionOptions;
  sentenceSelection?: CandidateSelectionOptions;
}

export interface CombinedHintsOptions {
  queryKind: 'user' | 'tool-response';
  maxQueryLength?: number;
  queryPhraseWeightingMode?: QueryPhraseWeightingMode;
  memory: SearchOptions & HintSourceControls;
  notes: HintSourceControls;
  conversations: HintSourceControls;
}

interface ContentCandidate {
  row: StoredContentRow;
  score: number;
  weightedScore: number;
  selectedSentences: string[];
  selectedSentenceIndices: number[];
  formatted: string;
  sentenceSelection?: ReturnType<typeof selectScores>;
}

type QueryVectors = { global: number[]; phrases: number[][] };
type QueryVectorResolver = (model: string) => Promise<QueryVectors>;

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function providerForModel(model: string): 'google' | 'openrouter' {
  return model.includes('/') ? 'openrouter' : 'google';
}

function selectionWithDefaults(value: CandidateSelectionOptions | undefined): Required<CandidateSelectionOptions> {
  const minCandidates = Math.max(1, Math.floor(value?.minCandidates ?? 2));
  return {
    mode: value?.mode === 'threshold' || value?.mode === 'range' || value?.mode === 'auto' ? value.mode : 'top-k',
    topK: Math.max(1, Math.floor(value?.topK ?? 5)),
    threshold: Number.isFinite(value?.threshold) ? Number(value?.threshold) : 0.55,
    minCandidates,
    maxCandidates: Math.max(minCandidates, Math.floor(value?.maxCandidates ?? 8)),
  };
}

function selectScores(scores: SeedFactScore[], controls: CandidateSelectionOptions): {
  selected: SeedFactScore[];
  selection: Required<CandidateSelectionOptions>;
  autoAnalysis?: ReturnType<typeof analyzeAutoCandidateSelection>;
} {
  const selection = selectionWithDefaults(controls);
  const autoAnalysis = selection.mode === 'auto' ? analyzeAutoCandidateSelection(scores, selection) : undefined;
  return { selected: selectSeedFacts(scores, selection), selection, autoAnalysis };
}

function wordCount(text: string): number {
  return String(text || '').trim().split(/\s+/u).filter(Boolean).length;
}

function formatSelectedSentences(sentences: StoredContentSentenceRow[], selectedIndices: number[]): string[] {
  if (sentences.length === 0 || selectedIndices.length === 0) return [];
  const selected = new Set(selectedIndices);
  const output: string[] = [];
  let previous = -2;
  for (const sentence of sentences) {
    if (!selected.has(sentence.sentenceIndex)) continue;
    if (sentence.sentenceIndex > previous + 1) output.push('<...>');
    output.push(sentence.text);
    previous = sentence.sentenceIndex;
  }
  if (previous < sentences[sentences.length - 1]!.sentenceIndex) output.push('<...>');
  return output;
}

function noteAuthor(row: StoredContentRow): string {
  const isMarkdown = path.extname(row.originalName).toLowerCase() === '.md';
  if (isMarkdown) return /TELOS/i.test(row.originalName) ? 'Telos' : 'User';
  return row.author || 'User';
}

function identityDescription(name: string, identities: HintIdentity[]): string | undefined {
  return identities.find((identity) => identity.name.trim().toLowerCase() === name.trim().toLowerCase())?.description;
}

function formatContentCandidate(row: StoredContentRow, excerpt: string[], identities: HintIdentity[]): string {
  const created = new Date(row.createdAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
  const updated = new Date(row.updatedAt).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' });
  if (row.collection === 'notes') {
    const mediaType = row.kind === 'text' ? 'text note' : `${row.kind} note`;
    return [
      `[NOTE: ${row.originalName || row.id}]`,
      `Author: ${noteAuthor(row)} | Type: ${mediaType} | Created: ${created} UTC | Edited: ${updated} UTC`,
      `Summary: ${row.summary}`,
      excerpt.join(' '),
    ].filter(Boolean).join('\n');
  }
  const labels = parseJson<string[]>(row.labelsJson, []).filter((label) => !['openrouter', 'imported', 'user', 'assistant'].includes(label.toLowerCase()));
  const participants = Array.from(new Set([row.author, ...labels].filter(Boolean)))
    .filter((value) => !/^spk_/i.test(value))
    .map((name) => {
      const description = identityDescription(name, identities);
      return description ? `${name} — ${description}` : name;
    });
  return [
    `[CONVERSATION TURN: ${created} UTC]`,
    participants.length > 0 ? `Subjects: ${participants.join('; ')}` : '',
    excerpt.join(' '),
  ].filter(Boolean).join('\n');
}

async function queryVectorsForModels(models: string[], resolveVectors: QueryVectorResolver): Promise<Map<string, QueryVectors>> {
  const vectors = new Map<string, QueryVectors>();
  await Promise.all(models.map(async (model) => vectors.set(model, await resolveVectors(model))));
  return vectors;
}

function scoreEmbedding(
  embedding: number[],
  queryVectors: { global: number[]; phrases: number[][] },
  phrases: WeightedQueryPhrase[],
  aggregation: PhraseAggregationMode,
  overallEmbeddingWeight: number,
): number {
  let score = Math.max(0, cosineSimilarity(queryVectors.global, embedding)) * overallEmbeddingWeight;
  const phraseContributions = phrases.map((phrase, index) => Math.max(0, cosineSimilarity(queryVectors.phrases[index] || [], embedding)) * phrase.weight);
  score += aggregation === 'sum'
    ? phraseContributions.reduce((sum, value) => sum + value, 0)
    : Math.max(0, ...phraseContributions);
  return score;
}

export class CombinedMemoryHintsService {
  async test(input: {
    query: string;
    agent: LoadedAgent;
    categories?: string[];
    categoryMultipliers?: Record<string, number>;
    identities: HintIdentity[];
    options: CombinedHintsOptions;
  }): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    const maxLength = Math.max(1, Math.floor(input.options.maxQueryLength ?? 4000));
    const query = input.query.trim().slice(0, maxLength);
    if (!query) throw new Error('Enter a user message or tool response first.');
    const runtime = await getMemoryRuntime(input.agent.config.memory);
    const memoryControls = input.options.memory;
    const phraseWeightingMode = input.options.queryPhraseWeightingMode
      || (input.options.queryKind === 'tool-response'
        ? input.agent.config.memory?.autoHints?.toolResponsePhraseWeighting || 'embedding'
        : input.agent.config.memory?.autoHints?.userPhraseWeighting || 'embedding');
    const memoryStarted = Date.now();
    const queryVectorPromises = new Map<string, Promise<QueryVectors>>();
    let activePhrases: WeightedQueryPhrase[] = [];
    const resolveQueryVectors: QueryVectorResolver = (model) => {
      let pending = queryVectorPromises.get(model);
      if (!pending) {
        pending = embedBatch([query, ...activePhrases.map((phrase) => phrase.text)], model, {
          provider: providerForModel(model),
          label: 'query.combined_hints',
        }).then((embedded) => ({ global: embedded[0] || [], phrases: embedded.slice(1) }));
        queryVectorPromises.set(model, pending);
      }
      return pending;
    };
    let contentPromise: Promise<[Awaited<ReturnType<CombinedMemoryHintsService['searchContent']>>, Awaited<ReturnType<CombinedMemoryHintsService['searchContent']>>]> | null = null;
    let contentStarted = 0;
    const memoryResult = await runtime.service.search(query, {
      maxDepth: memoryControls.maxDepth,
      maxChains: memoryControls.maxChains,
      beamWidth: memoryControls.beamWidth,
      phraseAggregationMode: memoryControls.phraseAggregationMode,
      overallEmbeddingWeight: memoryControls.overallEmbeddingWeight,
      agentName: input.agent.config.name,
      categories: input.categories,
      includeUncategorized: memoryControls.includeUncategorized,
      fallbackCategory: memoryControls.fallbackCategory,
      categoryMultipliers: input.categoryMultipliers,
      queryPhraseWeightingMode: phraseWeightingMode,
      candidateSelection: memoryControls.candidateSelection,
      onQueryPrepared: (prepared) => {
        activePhrases = prepared.queryPhrases;
        queryVectorPromises.set(prepared.embeddingModel, Promise.resolve({
          global: prepared.globalEmbedding,
          phrases: prepared.phraseEmbeddings,
        }));
        contentStarted = Date.now();
        contentPromise = Promise.all([
          this.searchContent('notes', prepared.queryPhrases, prepared.phraseAggregationMode, prepared.overallEmbeddingWeight, input.options.notes, input.identities, resolveQueryVectors),
          this.searchContent('conversation_transcripts', prepared.queryPhrases, prepared.phraseAggregationMode, prepared.overallEmbeddingWeight, input.options.conversations, input.identities, resolveQueryVectors),
        ]);
      },
    });
    const memoryMs = Date.now() - memoryStarted;
    const phrases = memoryResult.queryPhrases;
    activePhrases = phrases;
    const aggregation = memoryResult.phraseAggregationMode;
    const overallWeight = memoryResult.overallEmbeddingWeight;
    if (!contentPromise) {
      contentStarted = Date.now();
      contentPromise = Promise.all([
        this.searchContent('notes', phrases, aggregation, overallWeight, input.options.notes, input.identities, resolveQueryVectors),
        this.searchContent('conversation_transcripts', phrases, aggregation, overallWeight, input.options.conversations, input.identities, resolveQueryVectors),
      ]);
    }
    const [notes, conversations] = await contentPromise;
    const contentMs = Date.now() - contentStarted;
    const sections = [
      memoryResult.text.trim() ? { source: 'memory', weightedScore: (memoryResult.seedFacts[0]?.score || 0) * memoryControls.weight, text: `[MEMORY]\n${memoryResult.text.trim()}` } : null,
      ...notes.candidates.map((candidate) => ({ source: 'notes', weightedScore: candidate.weightedScore, text: candidate.formatted })),
      ...conversations.candidates.map((candidate) => ({ source: 'conversations', weightedScore: candidate.weightedScore, text: candidate.formatted })),
    ].filter((section): section is NonNullable<typeof section> => Boolean(section))
      .sort((a, b) => b.weightedScore - a.weightedScore);

    return {
      text: sections.map((section) => section.text).join('\n\n'),
      query,
      queryKind: input.options.queryKind,
      phraseWeightingMode,
      queryPhrases: phrases,
      memory: { ...memoryResult, sourceWeight: memoryControls.weight, durationMs: memoryMs },
      notes,
      conversations,
      sections,
      durationMs: Date.now() - startedAt,
      parallelContentDurationMs: contentMs,
    };
  }

  private async searchContent(
    collection: ContentCollection,
    phrases: WeightedQueryPhrase[],
    aggregation: PhraseAggregationMode,
    overallWeight: number,
    controls: HintSourceControls,
    identities: HintIdentity[],
    resolveQueryVectors: QueryVectorResolver,
  ): Promise<Record<string, unknown> & { candidates: ContentCandidate[] }> {
    const startedAt = Date.now();
    const content = getContentMemoryService();
    const rows = (await content.rows(collection))
      .filter((row) => !row.expiresAt || new Date(row.expiresAt).getTime() > Date.now())
      .filter((row) => parseJson<number[]>(row.embeddingJson, []).length > 0);
    if (rows.length === 0) return { candidates: [], scores: [], durationMs: Date.now() - startedAt };
    const models = Array.from(new Set(rows.map((row) => row.embeddingModel).filter(Boolean)));
    const vectorsByModel = await queryVectorsForModels(models, resolveQueryVectors);
    const newest = Math.max(Date.now(), ...rows.map((row) => new Date(row.updatedAt || row.createdAt).getTime()).filter(Number.isFinite));
    const scored = rows.map((row) => {
      const embedding = parseJson<number[]>(row.embeddingJson, []);
      const semantic = scoreEmbedding(embedding, vectorsByModel.get(row.embeddingModel) || { global: [], phrases: [] }, phrases, aggregation, overallWeight);
      const ageDays = Math.max(0, (newest - new Date(row.updatedAt || row.createdAt).getTime()) / (24 * 60 * 60 * 1000));
      const recency = Math.exp(-ageDays / 30);
      return { factId: row.id, score: semantic + Math.max(0, controls.recencyBias || 0) * 0.1 * recency };
    }).sort((a, b) => b.score - a.score);
    const selected = selectScores(scored, controls.candidateSelection);
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const candidates = await Promise.all(selected.selected.map(async (score): Promise<ContentCandidate> => {
      const row = rowById.get(score.factId)!;
      const sentenceRows = await content.getOrCreateSentenceEmbeddings(row);
      let excerpt = row.kind === 'text' ? [row.text] : [row.summary];
      let selectedSentenceIndices: number[] = [];
      let sentenceSelection: ReturnType<typeof selectScores> | undefined;
      if (sentenceRows.length > 0 && wordCount(row.text) > 30) {
        const sentenceModel = sentenceRows[0]!.embeddingModel;
        const sentenceVectors = await queryVectorsForModels([sentenceModel], resolveQueryVectors);
        const sentenceScores = sentenceRows.map((sentence) => ({
          factId: sentence.id,
          score: scoreEmbedding(
            parseJson<number[]>(sentence.embeddingJson, []),
            sentenceVectors.get(sentenceModel) || { global: [], phrases: [] },
            phrases,
            aggregation,
            overallWeight,
          ),
        })).sort((a, b) => b.score - a.score);
        sentenceSelection = selectScores(sentenceScores, controls.sentenceSelection || { mode: 'top-k', topK: 4 });
        const indexById = new Map(sentenceRows.map((sentence) => [sentence.id, sentence.sentenceIndex]));
        selectedSentenceIndices = sentenceSelection.selected.map((item) => indexById.get(item.factId)!).filter(Number.isFinite).sort((a, b) => a - b);
        excerpt = formatSelectedSentences(sentenceRows, selectedSentenceIndices);
      }
      return {
        row: { ...row, embeddingJson: '' },
        score: score.score,
        weightedScore: score.score * Math.max(0, controls.weight),
        selectedSentences: excerpt,
        selectedSentenceIndices,
        formatted: formatContentCandidate(row, excerpt, identities),
        ...(sentenceSelection ? { sentenceSelection } : {}),
      };
    }));
    return {
      candidates,
      scores: scored.slice(0, 50),
      selection: selected.selection,
      autoAnalysis: selected.autoAnalysis,
      durationMs: Date.now() - startedAt,
    };
  }
}
