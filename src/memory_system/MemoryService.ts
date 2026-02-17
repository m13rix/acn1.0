import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { extname, isAbsolute, relative, resolve } from 'path';
import { getGlobalDisplay } from '../core/GlobalDisplay.js';
import { cosineSimilarity, embedBatch, embedText, vectorSubtract } from './embeddings.js';
import { enrichDocFacts } from './doc_enricher.js';
import { parseDocumentToGraph } from './doc_parser.js';
import { generateAutoLinks } from './linker.js';
import { searchGraphChains } from './search.js';
import { MemoryStore } from './store.js';
import type {
  AddDocResult,
  AddFactInput,
  AddFactResult,
  AddFactsInput,
  AddFactsResult,
  AddLinksInput,
  AddLinksResult,
  FactRecord,
  LinkRecord,
  ManualLinkInput,
  MemoryRuntimeConfig,
  SearchOptions,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeRelation(relation: string): string {
  return relation.trim().toLowerCase().replace(/\s+/g, ' ');
}

function linkKey(fromFactId: string, toFactId: string, relation: string): string {
  return `${fromFactId}::${toFactId}::${normalizeRelation(relation)}`;
}

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function ensureConfidence(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a number in range [0,1].`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be in range [0,1].`);
  }
  return value;
}

function ensureTopics(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must contain at least one topic string.`);
  }
  const topics = value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  if (topics.length === 0) {
    throw new Error(`${field} must contain at least one non-empty topic string.`);
  }
  return topics;
}

function resolveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function isInsidePath(basePath: string, targetPath: string): boolean {
  const normalizedBase = resolve(basePath);
  const normalizedTarget = resolve(targetPath);
  const rel = relative(normalizedBase, normalizedTarget);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolveConfig(input?: Partial<MemoryRuntimeConfig>): MemoryRuntimeConfig {
  const cfg = input ?? {};
  return {
    table: (typeof cfg.table === 'string' && cfg.table.trim()) ? cfg.table.trim() : DEFAULT_MEMORY_CONFIG.table,
    linkerProvider: (typeof cfg.linkerProvider === 'string' && cfg.linkerProvider.trim()) ? cfg.linkerProvider.trim() : DEFAULT_MEMORY_CONFIG.linkerProvider,
    linkerModel: (typeof cfg.linkerModel === 'string' && cfg.linkerModel.trim()) ? cfg.linkerModel.trim() : DEFAULT_MEMORY_CONFIG.linkerModel,
    linkerTemperature: typeof cfg.linkerTemperature === 'number' ? cfg.linkerTemperature : DEFAULT_MEMORY_CONFIG.linkerTemperature,
    linkerMaxTokens: resolveInt(cfg.linkerMaxTokens, DEFAULT_MEMORY_CONFIG.linkerMaxTokens),
    docParserProvider: (typeof cfg.docParserProvider === 'string' && cfg.docParserProvider.trim()) ? cfg.docParserProvider.trim() : DEFAULT_MEMORY_CONFIG.docParserProvider,
    docParserModel: (typeof cfg.docParserModel === 'string' && cfg.docParserModel.trim()) ? cfg.docParserModel.trim() : DEFAULT_MEMORY_CONFIG.docParserModel,
    docParserTemperature: typeof cfg.docParserTemperature === 'number' ? cfg.docParserTemperature : DEFAULT_MEMORY_CONFIG.docParserTemperature,
    docParserMaxTokens: resolveInt(cfg.docParserMaxTokens, DEFAULT_MEMORY_CONFIG.docParserMaxTokens),
    docCrossLinkMax: resolveInt(cfg.docCrossLinkMax, DEFAULT_MEMORY_CONFIG.docCrossLinkMax),
    docEnricherProvider: (typeof cfg.docEnricherProvider === 'string' && cfg.docEnricherProvider.trim()) ? cfg.docEnricherProvider.trim() : DEFAULT_MEMORY_CONFIG.docEnricherProvider,
    docEnricherModel: (typeof cfg.docEnricherModel === 'string' && cfg.docEnricherModel.trim()) ? cfg.docEnricherModel.trim() : DEFAULT_MEMORY_CONFIG.docEnricherModel,
    docEnricherTemperature: typeof cfg.docEnricherTemperature === 'number' ? cfg.docEnricherTemperature : DEFAULT_MEMORY_CONFIG.docEnricherTemperature,
    docEnricherMaxTokens: resolveInt(cfg.docEnricherMaxTokens, DEFAULT_MEMORY_CONFIG.docEnricherMaxTokens),
    docFactConfidenceFallback: typeof cfg.docFactConfidenceFallback === 'number' ? clamp01(cfg.docFactConfidenceFallback) : DEFAULT_MEMORY_CONFIG.docFactConfidenceFallback,
    docTopicFallback: (typeof cfg.docTopicFallback === 'string' && cfg.docTopicFallback.trim()) ? cfg.docTopicFallback.trim() : DEFAULT_MEMORY_CONFIG.docTopicFallback,
    embeddingModel: (typeof cfg.embeddingModel === 'string' && cfg.embeddingModel.trim()) ? cfg.embeddingModel.trim() : DEFAULT_MEMORY_CONFIG.embeddingModel,
    candidateFactsPerTopic: resolveInt(cfg.candidateFactsPerTopic, DEFAULT_MEMORY_CONFIG.candidateFactsPerTopic),
    candidatePoolMax: resolveInt(cfg.candidatePoolMax, DEFAULT_MEMORY_CONFIG.candidatePoolMax),
    maxAutoLinksPerFact: resolveInt(cfg.maxAutoLinksPerFact, DEFAULT_MEMORY_CONFIG.maxAutoLinksPerFact),
    dedupeThreshold: typeof cfg.dedupeThreshold === 'number' ? clamp01(cfg.dedupeThreshold) : DEFAULT_MEMORY_CONFIG.dedupeThreshold,
    searchMaxDepth: resolveInt(cfg.searchMaxDepth, DEFAULT_MEMORY_CONFIG.searchMaxDepth),
    searchMaxStartFacts: resolveInt(cfg.searchMaxStartFacts, DEFAULT_MEMORY_CONFIG.searchMaxStartFacts),
    searchMaxChains: resolveInt(cfg.searchMaxChains, DEFAULT_MEMORY_CONFIG.searchMaxChains),
  };
}

interface PreparedNewFact {
  id: string;
  ref: string;
  text: string;
  confidence: number;
  topics: string[];
}

interface ResolvedManualLink {
  fromFactId: string;
  toFactId: string;
  relation: string;
  confidence: number;
}

export class MemoryService {
  private readonly config: MemoryRuntimeConfig;
  private readonly store: MemoryStore;
  private initialized = false;

  constructor(config?: Partial<MemoryRuntimeConfig>) {
    this.config = resolveConfig(config);
    this.store = new MemoryStore(this.config.table);
  }

  getRuntimeConfig(): MemoryRuntimeConfig {
    return { ...this.config };
  }

  async getAllFacts(): Promise<FactRecord[]> {
    await this.initialize();
    return this.store.getAllFacts();
  }

  async getAllLinks(): Promise<LinkRecord[]> {
    await this.initialize();
    return this.store.getAllLinks();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    this.initialized = true;
  }

  async addFact(input: AddFactInput): Promise<AddFactResult> {
    const text = ensureNonEmptyString(input.fact, 'fact');
    const confidence = ensureConfidence(input.confidence, 'confidence');
    const topics = ensureTopics(input.topics, 'topics');

    const result = await this.addFacts({
      facts: [{
        ref: input.ref,
        text,
        confidence,
        topics,
      }],
    });

    const fact = result.facts[0];
    if (!fact) {
      throw new Error('addFact failed: no inserted fact in result.');
    }

    return {
      ...result,
      factId: fact.factId,
      ref: fact.ref,
    };
  }

  async addFacts(input: AddFactsInput): Promise<AddFactsResult> {
    await this.initialize();
    if (!Array.isArray(input.facts) || input.facts.length === 0) {
      throw new Error('addFacts requires at least one fact.');
    }

    const preparedFacts: PreparedNewFact[] = [];
    const refMap = new Map<string, string>();
    const seenRefs = new Set<string>();

    for (let i = 0; i < input.facts.length; i++) {
      const raw = input.facts[i];
      if (!raw) continue;
      const text = ensureNonEmptyString(raw.text, `facts[${i}].text`);
      const confidence = ensureConfidence(raw.confidence, `facts[${i}].confidence`);
      const topics = ensureTopics(raw.topics, `facts[${i}].topics`);
      const ref = (raw.ref && raw.ref.trim()) ? raw.ref.trim() : `fact_${i + 1}`;
      if (seenRefs.has(ref)) {
        throw new Error(`Duplicate fact ref "${ref}" in addFacts call.`);
      }
      seenRefs.add(ref);

      const id = randomUUID();
      preparedFacts.push({ id, ref, text, confidence, topics });
      refMap.set(ref, id);
    }

    const display = getGlobalDisplay();
    if (display) {
      display.showMemoryLog(`Adding ${preparedFacts.length} new facts to system...`);
      for (const f of preparedFacts) {
        display.showMemoryStep(`Fact [${f.ref}]: "${f.text.substring(0, 100)}${f.text.length > 100 ? '...' : ''}"`);
        display.showMemoryStep(`  Topics: ${f.topics.join(', ')}`);
      }
    }

    const existingFacts = await this.store.getAllFacts();
    const existingLinks = await this.store.getAllLinks();

    if (display) display.showMemoryStep("Generating embeddings...");
    const factEmbeddings = await embedBatch(preparedFacts.map(f => f.text), this.config.embeddingModel);
    const topicEmbeddingsNested = await Promise.all(
      preparedFacts.map(f => {
        if (display) display.showMemoryEmbedding(f.text);
        return embedBatch(f.topics, this.config.embeddingModel);
      })
    );

    const now = Date.now();
    const newFactRecords: FactRecord[] = preparedFacts.map((fact, idx) => ({
      id: fact.id,
      text: fact.text,
      confidence: fact.confidence,
      embedding: factEmbeddings[idx] ?? [],
      topics: fact.topics,
      topicEmbeddings: topicEmbeddingsNested[idx] ?? [],
      createdAt: now,
      updatedAt: now,
    }));

    const allFactsById = new Map<string, FactRecord>();
    for (const fact of existingFacts) allFactsById.set(fact.id, fact);
    for (const fact of newFactRecords) allFactsById.set(fact.id, fact);

    if (display) display.showMemoryStep("Finding candidate facts for auto-linking...");
    const candidateResults = this.collectCandidateResults(existingFacts, newFactRecords);
    const candidateFacts = candidateResults.map(r => r.fact);

    if (display && candidateResults.length > 0) {
      display.showMemoryRetrieval("new facts topics", candidateResults.map(r => ({
        text: r.fact.text,
        score: r.score
      })));
    }
    const promptCandidates = [
      ...candidateFacts.map(f => ({ id: f.id, text: f.text, confidence: f.confidence, topics: f.topics })),
      ...newFactRecords.map(f => ({ id: f.id, text: f.text, confidence: f.confidence, topics: f.topics })),
    ];

    const autoSuggestions = await generateAutoLinks({
      newFacts: newFactRecords.map(f => ({ id: f.id, text: f.text, confidence: f.confidence, topics: f.topics })),
      candidateFacts: promptCandidates,
      manualLinks: [],
      maxAutoLinksPerFact: this.config.maxAutoLinksPerFact,
    }, this.config);

    if (display) display.showMemoryStep(`Linker suggested ${autoSuggestions.length} links. Processing...`);

    const existingKeys = new Set<string>(
      existingLinks.map(link => linkKey(link.fromFactId, link.toFactId, link.relation))
    );

    const newFactIdSet = new Set<string>(newFactRecords.map(f => f.id));
    const newFactLinkCount = new Map<string, number>();
    const acceptedAuto = autoSuggestions.filter(item => {
      const from = item.fromFactId.trim();
      const to = item.toFactId.trim();
      const relation = item.relation.trim();
      if (!from || !to || !relation) return false;
      if (from === to) return false;
      if (!allFactsById.has(from) || !allFactsById.has(to)) return false;
      if (!newFactIdSet.has(from) && !newFactIdSet.has(to)) return false;

      const key = linkKey(from, to, relation);
      if (existingKeys.has(key)) return false;

      const impacted = [from, to].filter(id => newFactIdSet.has(id));
      for (const factId of impacted) {
        const current = newFactLinkCount.get(factId) ?? 0;
        if (current >= this.config.maxAutoLinksPerFact) {
          return false;
        }
      }

      for (const factId of impacted) {
        const current = newFactLinkCount.get(factId) ?? 0;
        newFactLinkCount.set(factId, current + 1);
      }
      existingKeys.add(key);
      return true;
    }).map(item => ({
      fromFactId: item.fromFactId.trim(),
      toFactId: item.toFactId.trim(),
      relation: item.relation.trim(),
      confidence: clamp01(typeof item.confidence === 'number' ? item.confidence : 0.55),
    }));

    const autoLinkRecords = await this.buildLinksFromResolved(acceptedAuto, allFactsById, false);

    if (display && acceptedAuto.length > 0) {
      display.showMemoryLog(`Accepted ${acceptedAuto.length} auto-links:`);
      for (const link of acceptedAuto) {
        const from = allFactsById.get(link.fromFactId)?.text.substring(0, 40) + '...';
        const to = allFactsById.get(link.toFactId)?.text.substring(0, 40) + '...';
        display.showMemoryStep(`  [${link.relation}] ${from} -> ${to} (${(link.confidence * 100).toFixed(0)}%)`);
      }
    }

    if (display) display.showMemoryStep("Checking for semantic near-duplicates...");
    const softMergeLinks = await this.buildSoftMergeLinks(newFactRecords, existingFacts, existingKeys, allFactsById);
    if (display && softMergeLinks.length > 0) {
      display.showMemoryLog(`Found ${softMergeLinks.length} semantic near-duplicates:`);
      for (const link of softMergeLinks) {
        const from = allFactsById.get(link.fromFactId)?.text.substring(0, 40) + '...';
        const to = allFactsById.get(link.toFactId)?.text.substring(0, 40) + '...';
        display.showMemoryStep(`  ${from} is similar to ${to} (${(link.confidence * 100).toFixed(0)}%)`);
      }
    }

    const allNewLinks = [...autoLinkRecords, ...softMergeLinks];
    const factIds = newFactRecords.map(f => f.id);
    const linkIds = allNewLinks.map(link => link.id);

    try {
      if (display) display.showMemoryStep(`Saving ${newFactRecords.length} facts and ${allNewLinks.length} total links to store...`);
      await this.store.addFacts(newFactRecords);
      await this.store.addLinks(allNewLinks);
      if (display) display.showMemoryLog("✅ Memory updated successfully.");
    } catch (error) {
      await Promise.allSettled([
        this.store.deleteLinksByIds(linkIds),
        this.store.deleteFactsByIds(factIds),
      ]);
      throw error;
    }

    const resultRefMap: Record<string, string> = {};
    for (const [ref, id] of refMap.entries()) {
      resultRefMap[ref] = id;
    }

    return {
      facts: preparedFacts.map(fact => ({
        factId: fact.id,
        ref: fact.ref,
        text: fact.text,
      })),
      refMap: resultRefMap,
      autoLinks: autoLinkRecords.length,
      softMergeLinks: softMergeLinks.length,
      totalLinks: allNewLinks.length,
    };
  }

  async addLinks(input: AddLinksInput): Promise<AddLinksResult> {
    await this.initialize();
    if (!Array.isArray(input.links) || input.links.length === 0) {
      throw new Error('addLinks requires at least one link.');
    }

    const facts = await this.store.getAllFacts();
    if (facts.length === 0) {
      throw new Error('addLinks failed: memory has no facts yet.');
    }

    const allFactsById = new Map<string, FactRecord>();
    for (const fact of facts) allFactsById.set(fact.id, fact);

    const refMap = new Map<string, string>();
    if (input.refMap && typeof input.refMap === 'object') {
      for (const [ref, factId] of Object.entries(input.refMap)) {
        const cleanRef = ensureNonEmptyString(ref, 'refMap key');
        const cleanFactId = ensureNonEmptyString(factId, `refMap["${cleanRef}"]`);
        refMap.set(cleanRef, cleanFactId);
      }
    }

    const resolvedLinks = this.resolveManualLinks(input.links, refMap, allFactsById, 'links');
    const existingLinks = await this.store.getAllLinks();
    const existingKeys = new Set<string>(
      existingLinks.map(link => linkKey(link.fromFactId, link.toFactId, link.relation))
    );

    const acceptedLinks: ResolvedManualLink[] = [];
    for (const link of resolvedLinks) {
      const key = linkKey(link.fromFactId, link.toFactId, link.relation);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      acceptedLinks.push(link);
    }

    const linkRecords = await this.buildLinksFromResolved(acceptedLinks, allFactsById, true);
    const linkIds = linkRecords.map(link => link.id);

    try {
      await this.store.addLinks(linkRecords);
    } catch (error) {
      await this.store.deleteLinksByIds(linkIds);
      throw error;
    }

    return {
      created: linkRecords.length,
      skipped: Math.max(0, input.links.length - linkRecords.length),
      total: input.links.length,
    };
  }

  async addDoc(path: string): Promise<AddDocResult> {
    await this.initialize();
    const docPathInput = ensureNonEmptyString(path, 'path');
    const sandboxRoot = resolve(process.cwd());
    const resolvedPath = resolve(sandboxRoot, docPathInput);

    if (!isInsidePath(sandboxRoot, resolvedPath)) {
      throw new Error(`Path "${docPathInput}" is outside sandbox directory.`);
    }

    const ext = extname(resolvedPath).toLowerCase();
    if (ext !== '.md' && ext !== '.txt') {
      throw new Error(`addDoc supports only .md or .txt files. Got "${ext || 'unknown'}".`);
    }

    const content = await readFile(resolvedPath, 'utf8');
    if (!content.trim()) {
      throw new Error(`Document "${docPathInput}" is empty.`);
    }

    const display = getGlobalDisplay();
    if (display) {
      display.showMemoryLog(`Importing document: ${docPathInput}`);
    }

    const existingFactsBeforeDoc = await this.store.getAllFacts();
    const parsed = await parseDocumentToGraph(content, this.config);
    if (parsed.facts.length === 0) {
      throw new Error('Doc parser returned zero facts.');
    }

    const warnings: string[] = [];
    let enrichmentById = new Map<number, { topics: string[]; confidence: number }>();
    try {
      const enriched = await enrichDocFacts(parsed.facts, this.config);
      enrichmentById = new Map(
        enriched.map(item => [item.id, { topics: item.topics, confidence: item.confidence }])
      );
    } catch (error) {
      warnings.push(
        `Doc enricher failed, using fallbacks: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const addFactsInput: AddFactsInput = {
      facts: parsed.facts.map(fact => {
        const enriched = enrichmentById.get(fact.id);
        const topics = (enriched?.topics && enriched.topics.length > 0)
          ? enriched.topics
          : [this.config.docTopicFallback];
        const confidence = typeof enriched?.confidence === 'number'
          ? clamp01(enriched.confidence)
          : this.config.docFactConfidenceFallback;

        return {
          ref: `doc_${fact.id}`,
          text: fact.content,
          confidence,
          topics,
        };
      }),
    };

    const addFactsResult = await this.addFacts(addFactsInput);
    const docFactIds = addFactsResult.facts.map(f => f.factId);
    const rollbackDocImport = async () => {
      await Promise.allSettled([
        this.store.deleteLinksByFactIds(docFactIds),
        this.store.deleteFactsByIds(docFactIds),
      ]);
    };

    let internalLinksCreated = 0;
    try {
      if (parsed.links.length > 0) {
        const internalLinksResult = await this.addLinks({
          links: parsed.links.map(link => ({
            from: { ref: `doc_${link.fromId}` },
            to: { ref: `doc_${link.toId}` },
            relation: link.relation,
            confidence: link.confidence,
          })),
          refMap: addFactsResult.refMap,
        });
        internalLinksCreated = internalLinksResult.created;
      }
    } catch (error) {
      await rollbackDocImport();
      throw error;
    }

    let externalAutoLinksCreated = 0;
    try {
      if (existingFactsBeforeDoc.length > 0 && this.config.docCrossLinkMax > 0) {
        const allFacts = await this.store.getAllFacts();
        const allById = new Map<string, FactRecord>(allFacts.map(f => [f.id, f]));
        const docFacts = docFactIds
          .map(id => allById.get(id))
          .filter((fact): fact is FactRecord => Boolean(fact));
        const externalCandidates = this.collectDocExternalCandidates(
          docFacts,
          existingFactsBeforeDoc,
          this.config.docCrossLinkMax
        );

        if (docFacts.length > 0 && externalCandidates.length > 0) {
          const docSet = new Set<string>(docFacts.map(f => f.id));
          const externalSet = new Set<string>(externalCandidates.map(f => f.id));
          const existingLinks = await this.store.getAllLinks();
          const existingKeys = new Set<string>(
            existingLinks.map(link => linkKey(link.fromFactId, link.toFactId, link.relation))
          );

          const suggestions = await generateAutoLinks({
            newFacts: docFacts.map(f => ({ id: f.id, text: f.text, confidence: f.confidence, topics: f.topics })),
            candidateFacts: [
              ...docFacts.map(f => ({ id: f.id, text: f.text, confidence: f.confidence, topics: f.topics })),
              ...externalCandidates.map(f => ({ id: f.id, text: f.text, confidence: f.confidence, topics: f.topics })),
            ],
            manualLinks: [],
            maxAutoLinksPerFact: this.config.maxAutoLinksPerFact,
          }, this.config);

          const filtered = suggestions.filter(link => {
            const from = link.fromFactId.trim();
            const to = link.toFactId.trim();
            const relation = link.relation.trim();
            if (!from || !to || !relation) return false;
            if (from === to) return false;

            const isDocExternal = (docSet.has(from) && externalSet.has(to)) || (externalSet.has(from) && docSet.has(to));
            if (!isDocExternal) return false;

            const key = linkKey(from, to, relation);
            if (existingKeys.has(key)) return false;
            existingKeys.add(key);
            return true;
          }).map(link => ({
            fromFactId: link.fromFactId.trim(),
            toFactId: link.toFactId.trim(),
            relation: link.relation.trim(),
            confidence: clamp01(typeof link.confidence === 'number' ? link.confidence : 0.55),
          }));

          if (filtered.length > 0) {
            const records = await this.buildLinksFromResolved(filtered, allById, false);
            await this.store.addLinks(records);
            externalAutoLinksCreated = records.length;
          }
        }
      }
    } catch (error) {
      warnings.push(
        `External cross-linking skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    return {
      documentPath: docPathInput,
      documentFactCount: docFactIds.length,
      documentInternalLinks: internalLinksCreated,
      documentExternalAutoLinks: externalAutoLinksCreated,
      factIds: docFactIds,
      refMap: addFactsResult.refMap,
      totalLinksAdded: addFactsResult.totalLinks + internalLinksCreated + externalAutoLinksCreated,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  async search(query: string, options: SearchOptions = {}): Promise<string> {
    await this.initialize();
    const cleanQuery = ensureNonEmptyString(query, 'query');
    const facts = await this.store.getAllFacts();
    if (facts.length === 0) return '';
    const links = await this.store.getAllLinks();

    const queryVector = await embedText(cleanQuery, this.config.embeddingModel);
    const lines = searchGraphChains(queryVector, facts, links, {
      maxDepth: resolveInt(options.maxDepth, this.config.searchMaxDepth),
      maxStartFacts: resolveInt(options.maxStartFacts, this.config.searchMaxStartFacts),
      maxChains: resolveInt(options.maxChains, this.config.searchMaxChains),
      beamWidth: resolveInt(options.beamWidth, Math.max(this.config.searchMaxChains * 2, 6)),
    });

    return lines.join('\n');
  }

  private resolveManualLinks(
    manualLinks: ManualLinkInput[],
    refMap: Map<string, string>,
    allFactsById: Map<string, FactRecord>,
    fieldName: string
  ): ResolvedManualLink[] {
    const resolved: ResolvedManualLink[] = [];

    for (let i = 0; i < manualLinks.length; i++) {
      const link = manualLinks[i];
      if (!link) continue;
      const relation = ensureNonEmptyString(link.relation, `${fieldName}[${i}].relation`);
      const confidence = link.confidence === undefined ? 0.75 : ensureConfidence(link.confidence, `${fieldName}[${i}].confidence`);

      const fromFactId = this.resolveEndpoint(link.from, refMap, `${fieldName}[${i}].from`);
      const toFactId = this.resolveEndpoint(link.to, refMap, `${fieldName}[${i}].to`);
      if (!allFactsById.has(fromFactId)) {
        throw new Error(`${fieldName}[${i}].from points to unknown fact ID "${fromFactId}".`);
      }
      if (!allFactsById.has(toFactId)) {
        throw new Error(`${fieldName}[${i}].to points to unknown fact ID "${toFactId}".`);
      }
      if (fromFactId === toFactId) continue;

      resolved.push({ fromFactId, toFactId, relation, confidence });
    }

    return resolved;
  }

  private resolveEndpoint(
    endpoint: { id?: string; ref?: string } | undefined,
    refMap: Map<string, string>,
    label: string
  ): string {
    if (!endpoint || typeof endpoint !== 'object') {
      throw new Error(`${label} must be an object with "id" or "ref".`);
    }
    if (endpoint.id && endpoint.id.trim()) {
      return endpoint.id.trim();
    }
    if (endpoint.ref && endpoint.ref.trim()) {
      const factId = refMap.get(endpoint.ref.trim());
      if (!factId) {
        throw new Error(`${label}.ref "${endpoint.ref}" is unknown. Pass a valid refMap or use id.`);
      }
      return factId;
    }
    throw new Error(`${label} must include "id" or "ref".`);
  }

  private async buildLinksFromResolved(
    links: Array<{
      fromFactId: string;
      toFactId: string;
      relation: string;
      confidence: number;
    }>,
    allFactsById: Map<string, FactRecord>,
    isManual: boolean
  ): Promise<LinkRecord[]> {
    if (links.length === 0) return [];
    const relationEmbeddings = await embedBatch(links.map(link => link.relation), this.config.embeddingModel);
    const now = Date.now();

    const records: LinkRecord[] = [];
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      if (!link) continue;
      const fromFact = allFactsById.get(link.fromFactId);
      const toFact = allFactsById.get(link.toFactId);
      const relationEmbedding = relationEmbeddings[i];
      if (!fromFact || !toFact || !relationEmbedding) continue;

      records.push({
        id: randomUUID(),
        fromFactId: link.fromFactId,
        toFactId: link.toFactId,
        relation: link.relation,
        confidence: clamp01(link.confidence),
        relationEmbedding,
        directionEmbedding: vectorSubtract(toFact.embedding, fromFact.embedding),
        isManual,
        createdAt: now,
        updatedAt: now,
      });
    }
    return records;
  }

  private collectCandidateResults(existingFacts: FactRecord[], newFacts: FactRecord[]): Array<{ fact: FactRecord; score: number }> {
    if (existingFacts.length === 0) return [];
    const scoreByFactId = new Map<string, number>();

    for (const newFact of newFacts) {
      for (const topicEmbedding of newFact.topicEmbeddings) {
        const scored = existingFacts
          .map(fact => ({
            fact,
            score: cosineSimilarity(topicEmbedding, fact.embedding),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, this.config.candidateFactsPerTopic);

        for (const item of scored) {
          const prev = scoreByFactId.get(item.fact.id);
          if (prev === undefined || item.score > prev) {
            scoreByFactId.set(item.fact.id, item.score);
          }
        }
      }
    }

    return Array.from(scoreByFactId.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.config.candidatePoolMax)
      .map(([factId, score]) => {
        const fact = existingFacts.find(fact => fact.id === factId);
        return fact ? { fact, score } : null;
      })
      .filter((item): item is { fact: FactRecord; score: number } => Boolean(item));
  }

  private collectDocExternalCandidates(
    docFacts: FactRecord[],
    externalFacts: FactRecord[],
    maxCandidates: number
  ): FactRecord[] {
    if (docFacts.length === 0 || externalFacts.length === 0 || maxCandidates <= 0) return [];

    const bestScoreByExternalId = new Map<string, number>();
    for (const docFact of docFacts) {
      for (const external of externalFacts) {
        const sim = cosineSimilarity(docFact.embedding, external.embedding);
        const prev = bestScoreByExternalId.get(external.id);
        if (prev === undefined || sim > prev) {
          bestScoreByExternalId.set(external.id, sim);
        }
      }
    }

    return Array.from(bestScoreByExternalId.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxCandidates)
      .map(([factId]) => externalFacts.find(f => f.id === factId))
      .filter((fact): fact is FactRecord => Boolean(fact));
  }

  private async buildSoftMergeLinks(
    newFacts: FactRecord[],
    existingFacts: FactRecord[],
    existingKeys: Set<string>,
    allFactsById: Map<string, FactRecord>
  ): Promise<LinkRecord[]> {
    if (newFacts.length === 0 || existingFacts.length === 0) return [];

    const relation = 'semantic-near-duplicate';
    const relationEmbedding = await embedText(relation, this.config.embeddingModel);
    const now = Date.now();
    const links: LinkRecord[] = [];

    for (const newFact of newFacts) {
      for (const existing of existingFacts) {
        const sim = cosineSimilarity(newFact.embedding, existing.embedding);
        if (sim < this.config.dedupeThreshold) continue;
        const key = linkKey(newFact.id, existing.id, relation);
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);

        const fromFact = allFactsById.get(newFact.id);
        const toFact = allFactsById.get(existing.id);
        if (!fromFact || !toFact) continue;

        links.push({
          id: randomUUID(),
          fromFactId: newFact.id,
          toFactId: existing.id,
          relation,
          confidence: clamp01(Math.max(0.5, Math.min(0.98, sim))),
          relationEmbedding,
          directionEmbedding: vectorSubtract(toFact.embedding, fromFact.embedding),
          isManual: false,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return links;
  }
}
