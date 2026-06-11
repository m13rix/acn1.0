import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { appendMemoryDebugEvent, createMemoryDebugTrace, finalizeMemoryDebugTrace, type MemoryDebugTrace } from '../../memory_system/debug.js';
import { getMemoryRuntime } from '../../memory_system/runtime.js';
import { DEFAULT_MEMORY_CONFIG, type CandidateSelectionOptions, type MemoryRuntimeConfig, type SearchOptions } from '../../memory_system/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_DIR = join(__dirname, '../client');
const PORT = Number(process.env.MEMORY_VIZ_PORT || 3000);
const DEBUG_SESSION_TTL_MS = 30 * 60 * 1000;

interface DebugSessionState {
  id: string;
  trace: MemoryDebugTrace;
  lastTouchedAt: number;
}

function normalizeAgentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLocaleLowerCase() : undefined;
}

function isVisibleToAgent(exclusiveToAgentName: string | null | undefined, allowedCategories: Set<string>, includeUncategorized: boolean): boolean {
  if (!exclusiveToAgentName) return includeUncategorized;
  return allowedCategories.has(exclusiveToAgentName.toLocaleLowerCase());
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readConfigFromEnv(): Partial<MemoryRuntimeConfig> {
  const aggregationMode = process.env.MEMORY_SEARCH_DEFAULT_AGGREGATION_MODE;
  const phraseWeightingMode = process.env.MEMORY_SEARCH_DEFAULT_PHRASE_WEIGHTING_MODE;
  const candidateMode = process.env.MEMORY_SEARCH_DEFAULT_CANDIDATE_MODE;

  return {
    table: process.env.MEMORY_TABLE || DEFAULT_MEMORY_CONFIG.table,
    mercuryProvider: process.env.MEMORY_MERCURY_PROVIDER || DEFAULT_MEMORY_CONFIG.mercuryProvider,
    mercuryModel: process.env.MEMORY_MERCURY_MODEL || DEFAULT_MEMORY_CONFIG.mercuryModel,
    mercuryTemperature: parseNumber(process.env.MEMORY_MERCURY_TEMPERATURE),
    mercuryMaxTokens: parseNumber(process.env.MEMORY_MERCURY_MAX_TOKENS),
    embeddingModel: process.env.MEMORY_EMBEDDING_MODEL || DEFAULT_MEMORY_CONFIG.embeddingModel,
    linkCandidatePoolMax: parseNumber(process.env.MEMORY_LINK_CANDIDATE_POOL_MAX),
    maxAutoLinksPerFact: parseNumber(process.env.MEMORY_MAX_AUTO_LINKS_PER_FACT),
    semanticMergeThreshold: parseNumber(process.env.MEMORY_SEMANTIC_MERGE_THRESHOLD),
    overallEmbeddingWeight: parseNumber(process.env.MEMORY_OVERALL_EMBEDDING_WEIGHT),
    searchDefaultAggregationMode: aggregationMode === 'sum' ? 'sum' : undefined,
    searchDefaultPhraseWeightingMode: phraseWeightingMode === 'embedding' ? 'embedding' : undefined,
    searchDefaultCandidateMode: candidateMode === 'threshold'
      ? 'threshold'
      : candidateMode === 'range'
        ? 'range'
        : candidateMode === 'top-k'
          ? 'top-k'
          : undefined,
    searchDefaultTopK: parseNumber(process.env.MEMORY_SEARCH_DEFAULT_TOP_K),
    searchDefaultThreshold: parseNumber(process.env.MEMORY_SEARCH_DEFAULT_THRESHOLD),
    searchDefaultRangeMin: parseNumber(process.env.MEMORY_SEARCH_DEFAULT_RANGE_MIN),
    searchDefaultRangeMax: parseNumber(process.env.MEMORY_SEARCH_DEFAULT_RANGE_MAX),
    searchMaxDepth: parseNumber(process.env.MEMORY_SEARCH_MAX_DEPTH),
    searchBeamWidth: parseNumber(process.env.MEMORY_SEARCH_BEAM_WIDTH),
    searchMaxChains: parseNumber(process.env.MEMORY_SEARCH_MAX_CHAINS),
  };
}

function normalizeHints(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? '').trim())
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  return [];
}

function parseCandidateSelection(value: unknown): CandidateSelectionOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const incoming = value as Record<string, unknown>;
  const mode = incoming.mode === 'threshold' || incoming.mode === 'range' || incoming.mode === 'top-k' || incoming.mode === 'auto'
    ? incoming.mode
    : undefined;
  const topK = parseNumber(incoming.topK);
  const threshold = parseNumber(incoming.threshold);
  const minCandidates = parseNumber(incoming.minCandidates);
  const maxCandidates = parseNumber(incoming.maxCandidates);

  return {
    ...(mode ? { mode } : {}),
    ...(typeof topK === 'number' ? { topK } : {}),
    ...(typeof threshold === 'number' ? { threshold } : {}),
    ...(typeof minCandidates === 'number' ? { minCandidates } : {}),
    ...(typeof maxCandidates === 'number' ? { maxCandidates } : {}),
  };
}

function parseSearchOptions(value: unknown): SearchOptions {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const incoming = value as Record<string, unknown>;
  const phraseAggregationMode = incoming.phraseAggregationMode === 'sum' || incoming.phraseAggregationMode === 'max'
    ? incoming.phraseAggregationMode
    : undefined;

  const categories = Array.isArray(incoming.categories)
    ? incoming.categories.map(String).filter(Boolean)
    : undefined;
  const includeUncategorized = typeof incoming.includeUncategorized === 'boolean'
    ? incoming.includeUncategorized
    : undefined;
  const fallbackCategory = typeof incoming.fallbackCategory === 'string' && incoming.fallbackCategory.trim()
    ? incoming.fallbackCategory.trim()
    : undefined;
  const categoryMultipliers = incoming.categoryMultipliers && typeof incoming.categoryMultipliers === 'object'
    ? Object.fromEntries(
        Object.entries(incoming.categoryMultipliers as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'number'),
      ) as Record<string, number>
    : undefined;

  return {
    ...(typeof parseNumber(incoming.maxDepth) === 'number' ? { maxDepth: parseNumber(incoming.maxDepth) } : {}),
    ...(typeof parseNumber(incoming.maxChains) === 'number' ? { maxChains: parseNumber(incoming.maxChains) } : {}),
    ...(typeof parseNumber(incoming.beamWidth) === 'number' ? { beamWidth: parseNumber(incoming.beamWidth) } : {}),
    ...(typeof parseNumber(incoming.overallEmbeddingWeight) === 'number'
      ? { overallEmbeddingWeight: parseNumber(incoming.overallEmbeddingWeight) }
      : {}),
    ...(phraseAggregationMode ? { phraseAggregationMode } : {}),
    ...(normalizeAgentName(incoming.agentName) ? { agentName: normalizeAgentName(incoming.agentName) } : {}),
    ...(categories && categories.length > 0 ? { categories } : {}),
    ...(typeof includeUncategorized === 'boolean' ? { includeUncategorized } : {}),
    ...(fallbackCategory ? { fallbackCategory } : {}),
    ...(categoryMultipliers && Object.keys(categoryMultipliers).length > 0 ? { categoryMultipliers } : {}),
    ...(parseCandidateSelection(incoming.candidateSelection) ? { candidateSelection: parseCandidateSelection(incoming.candidateSelection) } : {}),
  };
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const debugSessions = new Map<string, DebugSessionState>();

  const runtime = await getMemoryRuntime(readConfigFromEnv());
  const memory = runtime.service;
  try {
    console.log(`Connected to Memory Service (${memory.getRuntimeConfig().table})`);
  } catch (err) {
    console.error('Failed to connect to Memory Service:', err);
    process.exit(1);
  }

  app.use(express.static(CLIENT_DIR));
  app.use(express.json({ limit: '20mb' }));

  function pruneDebugSessions(): void {
    const now = Date.now();
    for (const [id, session] of debugSessions.entries()) {
      const finishedAt = session.trace.finishedAt ? new Date(session.trace.finishedAt).getTime() : null;
      const referenceTime = finishedAt ?? session.lastTouchedAt;
      if ((now - referenceTime) > DEBUG_SESSION_TTL_MS) {
        debugSessions.delete(id);
      }
    }
  }

  function createSessionTrace(sessionId: string, operation: string): MemoryDebugTrace {
    const { trace } = createMemoryDebugTrace(operation, (updatedTrace) => {
      const existing = debugSessions.get(sessionId);
      if (!existing) return;
      existing.trace = updatedTrace;
      existing.lastTouchedAt = Date.now();
    });
    debugSessions.set(sessionId, {
      id: sessionId,
      trace,
      lastTouchedAt: Date.now(),
    });
    return trace;
  }

  function resolveDebugTraceFromRequest(req: express.Request, operation: string): { debugEnabled: boolean; trace?: MemoryDebugTrace } {
    const debugEnabled = req.body?.debug !== false;
    if (!debugEnabled) {
      return { debugEnabled, trace: undefined };
    }

    const sessionId = String(req.body?.debugSessionId ?? '').trim();
    if (!sessionId) {
      const { trace } = createMemoryDebugTrace(operation);
      return { debugEnabled, trace };
    }

    pruneDebugSessions();
    return {
      debugEnabled,
      trace: createSessionTrace(sessionId, operation),
    };
  }

  app.get('/api/debug-session/:id', (req, res) => {
    pruneDebugSessions();
    const sessionId = String(req.params.id ?? '').trim();
    const since = Math.max(0, Math.floor(parseNumber(req.query.since) ?? 0));
    const session = debugSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Debug session not found.' });
      return;
    }

    session.lastTouchedAt = Date.now();
    const events = session.trace.events.slice(since);
    res.json({
      trace: {
        operation: session.trace.operation,
        startedAt: session.trace.startedAt,
        finishedAt: session.trace.finishedAt,
        durationMs: session.trace.durationMs,
        success: session.trace.success,
        events: session.trace.events,
      },
      nextOffset: session.trace.events.length,
      done: Boolean(session.trace.finishedAt),
      newEvents: events,
    });
  });

  app.get('/api/data', async (req, res) => {
    try {
      const agentName = normalizeAgentName(req.query.agentName);
      const allowedCategories = new Set<string>();
      if (agentName) allowedCategories.add(agentName);
      const rawCategories = typeof req.query.categories === 'string' ? req.query.categories : '';
      const extraCategories = rawCategories.split(',').map((c) => c.trim().toLocaleLowerCase()).filter(Boolean);
      for (const cat of extraCategories) {
        if (cat) allowedCategories.add(cat);
      }
      const includeUncategorized = req.query.includeUncategorized !== 'false';
      const [facts, hints, links, queueState, notesSyncState] = await Promise.all([
        memory.getAllFacts(),
        memory.getAllHints(),
        memory.getAllLinks(),
        runtime.queue.getState(),
        runtime.notesSync.getState(),
      ]);

      const visibleFacts = facts.filter((fact) => isVisibleToAgent(fact.exclusiveToAgentName, allowedCategories, includeUncategorized));
      const visibleFactIds = new Set(visibleFacts.map((fact) => fact.id));
      const visibleHints = hints.filter((hint) =>
        visibleFactIds.has(hint.factId) && isVisibleToAgent(hint.exclusiveToAgentName, allowedCategories, includeUncategorized),
      );
      const visibleLinks = links.filter((link) =>
        visibleFactIds.has(link.fromFactId)
        && visibleFactIds.has(link.toFactId)
        && isVisibleToAgent(link.exclusiveToAgentName, allowedCategories, includeUncategorized),
      );

      const hintCountByFactId = new Map<string, number>();
      for (const hint of visibleHints) {
        hintCountByFactId.set(hint.factId, (hintCountByFactId.get(hint.factId) ?? 0) + 1);
      }

      res.json({
        namespace: memory.getRuntimeConfig().table,
        agentName: agentName ?? null,
        nodes: visibleFacts.map((fact) => ({
          id: fact.id,
          text: fact.text,
          language: fact.language,
          parserMode: fact.parserMode,
          embedding: fact.globalEmbedding,
          exclusiveToAgentName: fact.exclusiveToAgentName,
          sourceId: fact.sourceId ?? null,
          sourceLabel: fact.sourceLabel ?? null,
          phraseCounts: {
            np: fact.phrases.np.length,
            vp: fact.phrases.vp.length,
            adjp: fact.phrases.adjp.length,
          },
          hintCount: hintCountByFactId.get(fact.id) ?? 0,
        })),
        links: visibleLinks.map((link) => ({
          id: link.id,
          source: link.fromFactId,
          target: link.toFactId,
          relation: link.relation,
          confidence: link.confidence,
        })),
        runtimeStatus: {
          queue: {
            spacingSeconds: Math.round((queueState.spacingMs || 0) / 1000),
            lastProcessedAt: queueState.lastProcessedAt,
            pendingJobs: queueState.jobs.length,
            nextJobAt: queueState.jobs
              .slice()
              .sort((left, right) => left.availableAt - right.availableAt)[0]?.availableAt ?? null,
          },
          notesSync: {
            trackedNotes: Object.keys(notesSyncState.trackedNotes || {}).length,
            pendingSettles: Object.keys(notesSyncState.pending || {}).length,
          },
        },
      });
    } catch (error) {
      console.error('Error fetching data:', error);
      res.status(500).json({ error: 'Failed to fetch memory data' });
    }
  });

  app.post('/api/ingest', async (req, res) => {
    const { debugEnabled, trace } = resolveDebugTraceFromRequest(req, 'memory-viz.ingest');
    const localTrace = trace ?? createMemoryDebugTrace('memory-viz.ingest').trace;
    try {
      const text = String(req.body?.text ?? '').trim();
      const retrievalHints = normalizeHints(req.body?.retrievalHints);
      const exclusiveToAgentName = normalizeAgentName(req.body?.exclusiveToAgentName);
      if (!text) {
        res.status(400).json({ error: 'text is required' });
        return;
      }

      appendMemoryDebugEvent(localTrace, 'memory-viz.request', 'Received queued add request from UI.', {
        debugEnabled,
        textLength: text.length,
        retrievalHintCount: retrievalHints.length,
        exclusiveToAgentName,
      });

      const result = await runtime.queue.enqueue({ text, retrievalHints, exclusiveToAgentName });
      finalizeMemoryDebugTrace(localTrace, true);
      res.json({ ok: true, result, ...(debugEnabled ? { debug: localTrace } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to queue memory add';
      appendMemoryDebugEvent(localTrace, 'memory-viz.error', 'Queued add request failed.', { error: message });
      finalizeMemoryDebugTrace(localTrace, false);
      console.error('Error in /api/ingest:', error);
      res.status(500).json({ error: message, debug: localTrace });
    }
  });

  app.post('/api/search', async (req, res) => {
    const { debugEnabled, trace } = resolveDebugTraceFromRequest(req, 'memory-viz.search');
    const localTrace = trace ?? createMemoryDebugTrace('memory-viz.search').trace;
    try {
      const query = String(req.body?.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'query is required' });
        return;
      }

      const options = parseSearchOptions(req.body?.options);
      appendMemoryDebugEvent(localTrace, 'memory-viz.request', 'Received search request from UI.', {
        debugEnabled,
        query,
        options,
      });
      const result = await memory.search(query, options, debugEnabled ? localTrace : undefined);
      finalizeMemoryDebugTrace(localTrace, true);
      res.json({
        ok: true,
        query,
        ...result,
        ...(debugEnabled ? { debug: localTrace } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed';
      appendMemoryDebugEvent(localTrace, 'memory-viz.error', 'Search request failed.', { error: message });
      finalizeMemoryDebugTrace(localTrace, false);
      console.error('Error in /api/search:', error);
      res.status(500).json({ error: message, debug: localTrace });
    }
  });

  app.post('/api/migrate-v1', async (req, res) => {
    const { debugEnabled, trace } = resolveDebugTraceFromRequest(req, 'memory-viz.migrate');
    const localTrace = trace ?? createMemoryDebugTrace('memory-viz.migrate').trace;
    try {
      const sourceNamespace = String(req.body?.sourceNamespace ?? 'global_memory').trim() || 'global_memory';
      appendMemoryDebugEvent(localTrace, 'memory-viz.request', 'Received migration request from UI.', {
        debugEnabled,
        sourceNamespace,
      });
      const result = await memory.migrateLegacyNamespace(sourceNamespace, debugEnabled ? localTrace : undefined);
      finalizeMemoryDebugTrace(localTrace, true);
      res.json({ ok: true, sourceNamespace, result, ...(debugEnabled ? { debug: localTrace } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Migration failed';
      appendMemoryDebugEvent(localTrace, 'memory-viz.error', 'Migration request failed.', { error: message });
      finalizeMemoryDebugTrace(localTrace, false);
      console.error('Error in /api/migrate-v1:', error);
      res.status(500).json({ error: message, debug: localTrace });
    }
  });

  server.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Memory Visualizer running at ${url}`);
    await open(url);
  });
}

startServer().catch(console.error);
