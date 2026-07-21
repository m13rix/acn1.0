import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import open from 'open';
import { getContentMemoryService, type ContentCollection, type StoredContentRow } from '../../content_memory/service.js';
import { RealtimeAdvisorStore } from '../../interfaces/realtime-advisor/store.js';
import { ensureMainProcessHeapLimit } from '../../runtime/nodeHeap.js';
import { AgentLoader } from '../../loaders/AgentLoader.js';
import { ToolLoader } from '../../loaders/ToolLoader.js';
import { getEffectiveMemoryCategories } from '../../core/memoryToolDocs.js';
import { CombinedMemoryHintsService, type CombinedHintsOptions } from '../../combined_memory_hints/service.js';
import { warmStanzaBridge } from '../../memory_system/stanzaRuntime.js';
import { getMemoryRuntime } from '../../memory_system/runtime.js';
import { embedText } from '../../memory_system/embeddings.js';

ensureMainProcessHeapLimit(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(__dirname, '../client');
const PORT = Number(process.env.CONTENT_EXPLORER_PORT || 3030);
const DATA_DIR = resolve(process.env.TELOS_REALTIME_ADVISOR_DATA_DIR || join(process.cwd(), 'data', 'realtime-advisor'));
const IMPORT_EMBEDDING_MODEL = process.env.MEMORY_IMPORTED_CONVERSATION_EMBEDDING_MODEL
  || process.env.MEMORY_CONVERSATION_TEXT_EMBEDDING_MODEL
  || 'qwen/qwen3-embedding-8b';

type OpenRouterMessage = {
  id: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  isEdited?: boolean;
  metadata?: Record<string, unknown>;
  items?: Array<{ id?: string; type?: string }>;
};

function json(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textFromItem(item: Record<string, unknown>): string {
  const data = json(item.data);
  if (data.type !== 'message') return '';
  const content = Array.isArray(data.content) ? data.content : [];
  return content.map((part) => {
    const value = json(part);
    return (value.type === 'input_text' || value.type === 'output_text') && typeof value.text === 'string' ? value.text : '';
  }).filter(Boolean).join('\n').trim();
}

function publicRow(row: StoredContentRow): Record<string, unknown> {
  return {
    ...row,
    embeddingJson: undefined,
    transcript: safeParse(row.transcriptJson),
    labels: safeParse(row.labelsJson),
    hasPreview: Boolean(row.archivePath),
  };
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return []; }
}

function displaySummary(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

function parseOpenRouterTurns(payload: Record<string, unknown>): Array<{ message: OpenRouterMessage; text: string }> {
  const items = json(payload.items);
  return (Object.values(json(payload.messages)) as OpenRouterMessage[])
    .filter((message) => message?.id && (message.type === 'user' || message.type === 'assistant'))
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))
    .map((message) => ({
      message,
      text: (message.items || []).map((reference) => textFromItem(json(items[reference.id || '']))).filter(Boolean).join('\n').trim(),
    }))
    .filter((turn) => turn.text);
}

async function start(): Promise<void> {
  const app = express();
  const server = createServer(app);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
  const memory = getContentMemoryService();
  const identities = new RealtimeAdvisorStore(DATA_DIR);
  const agentLoader = new AgentLoader();
  const toolLoader = new ToolLoader();
  const hintsService = new CombinedMemoryHintsService();
  await identities.initialize();
  const hintPrewarmPromise = Promise.all([
    memory.rows(),
    warmStanzaBridge(),
    agentLoader.loadByName('Telos-Code').then((agent) => agent ? Promise.all([
      getMemoryRuntime(agent.config.memory),
      embedText(
        'memory hint interactive search warmup',
        agent.config.memory?.embeddingModel || 'qwen/qwen3-embedding-8b',
        undefined,
        'query.prewarm',
        agent.config.memory?.embeddingProvider || 'openrouter',
      ),
    ]) : undefined),
  ]).then(() => {
    console.log('[content-explorer] Memory Hint Lab hot path is prewarmed.');
  }).catch((error) => {
    console.warn('[content-explorer] Background hint prewarm failed:', error instanceof Error ? error.message : String(error));
  });

  app.use(express.static(CLIENT_DIR));
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/identity-samples', express.static(identities.speakerSamplesDir));

  app.get('/api/overview', async (_req, res) => {
    const rows = await memory.rows();
    res.json({
      notes: rows.filter((row) => row.collection === 'notes').length,
      conversations: rows.filter((row) => row.collection === 'conversation_transcripts').length,
      identities: identities.listSpeakers().length,
      embeddingModel: IMPORT_EMBEDDING_MODEL,
    });
  });

  app.get('/api/hints/agents', async (_req, res) => {
    const agents = await agentLoader.loadAll();
    const allTools = await toolLoader.loadAll();
    const toolsByName = new Map(allTools.map((tool) => [tool.config.name, tool]));
    res.json({
      agents: agents
        .filter((agent) => agent.config.memory?.enabled !== false)
        .map((agent) => {
          const agentTools = (agent.config.tools || []).map((name) => toolsByName.get(name)).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
          return {
            name: agent.config.name,
            description: agent.config.description,
            memory: agent.config.memory || {},
            tools: agent.config.tools || [],
            effectiveCategories: getEffectiveMemoryCategories(agent, agentTools) || [],
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  });

  app.post('/api/hints/test', async (req, res) => {
    try {
      const agentName = String(req.body?.agentName || '').trim();
      const agent = await agentLoader.loadByName(agentName);
      if (!agent) throw new Error(`Unknown agent: ${agentName || '(empty)'}`);
      const tools = await toolLoader.loadByNames(agent.config.tools || []);
      const effectiveCategories = getEffectiveMemoryCategories(agent, tools) || [];
      const requestedCategories = Array.isArray(req.body?.categories)
        ? req.body.categories.map(String).map((value: string) => value.trim()).filter(Boolean)
        : effectiveCategories.map((category) => category.name);
      const defaultMultipliers = Object.fromEntries(
        effectiveCategories.filter((category) => typeof category.multiplier === 'number').map((category) => [category.name, category.multiplier!]),
      );
      const result = await hintsService.test({
        query: String(req.body?.query || ''),
        agent,
        categories: requestedCategories,
        categoryMultipliers: req.body?.categoryMultipliers && typeof req.body.categoryMultipliers === 'object'
          ? req.body.categoryMultipliers as Record<string, number>
          : defaultMultipliers,
        identities: identities.listSpeakers().map((identity) => ({ id: identity.id, name: identity.name, description: identity.description })),
        options: (req.body?.options || {}) as CombinedHintsOptions,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/search', async (req, res) => {
    try {
      const collection = req.body?.collection === 'conversation_transcripts' ? 'conversation_transcripts' : 'notes' as ContentCollection;
      const results = await memory.search(collection, String(req.body?.query || ''), {
        count: Number.isFinite(Number(req.body?.count)) ? Number(req.body.count) : undefined,
        recencyBias: Number.isFinite(Number(req.body?.recencyBias)) ? Number(req.body.recencyBias) : undefined,
        transcriptLabel: typeof req.body?.transcriptLabel === 'string' ? req.body.transcriptLabel : undefined,
      });
      res.json({ results });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/items/:id', async (req, res) => {
    const row = await memory.getRow(req.params.id);
    if (!row) return res.status(404).json({ error: 'Stored item not found.' });
    return res.json({ item: publicRow(row) });
  });

  app.get('/api/items/:id/preview', async (req, res) => {
    const row = await memory.getRow(req.params.id);
    if (!row?.archivePath) return res.status(404).json({ error: 'This item has no archived media preview.' });
    if (!(await stat(row.archivePath).then(() => true).catch(() => false))) return res.status(404).json({ error: 'Archived media is missing.' });
    return res.sendFile(row.archivePath);
  });

  app.get('/api/identities', (_req, res) => {
    res.json({ identities: identities.listSpeakers().map((speaker) => ({
      ...speaker,
      hasVoiceSample: Boolean(speaker.samplePath),
      sampleUrl: speaker.samplePath ? `/api/identity-samples/${encodeURIComponent(speaker.samplePath.split(/[\\/]/).pop() || '')}` : undefined,
    })) });
  });

  app.post('/api/identities', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!name || !description) return res.status(400).json({ error: 'Name and short description are required.' });
    const identity = await identities.createSpeaker({ name, description, samplePath: '' });
    return res.status(201).json({ identity });
  });

  app.post('/api/import/openrouter/preview', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) throw new Error('Choose an OpenRouter JSON export first.');
      const turns = parseOpenRouterTurns(JSON.parse(req.file.buffer.toString('utf8')) as Record<string, unknown>);
      if (!turns.length) throw new Error('No final user or assistant message items were found in this export.');
      res.json({
        turns: turns.map(({ message, text }) => ({ id: message.id, role: message.type, text, createdAt: message.createdAt, updatedAt: message.updatedAt, isEdited: Boolean(message.isEdited) })),
        skippedReasoning: true,
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/import/openrouter', upload.single('file'), async (req, res) => {
    try {
      if (!req.file) throw new Error('Choose an OpenRouter JSON export first.');
      const payload = JSON.parse(req.file.buffer.toString('utf8')) as Record<string, unknown>;
      const selectedUser = identities.getSpeaker(String(req.body?.userIdentityId || ''));
      const selectedAssistant = identities.getSpeaker(String(req.body?.assistantIdentityId || ''));
      if (!selectedUser || !selectedAssistant) throw new Error('Select an existing identity for both roles before embedding.');
      const sourceHash = createHash('sha256').update(req.file.buffer).digest('hex').slice(0, 20);
      const turns = parseOpenRouterTurns(payload);
      if (!turns.length) throw new Error('No final user or assistant message items were found in this export.');

      for (let start = 0; start < turns.length; start += 6) {
        await Promise.all(turns.slice(start, start + 6).map(async ({ message, text }) => {
          const role = message.type as 'user' | 'assistant';
          const identity = role === 'user' ? selectedUser : selectedAssistant;
          await memory.upsertText({
            collection: 'conversation_transcripts',
            id: `conversation_transcripts:openrouter:${sourceHash}:${message.id}`,
            text,
            summary: displaySummary(text),
            author: identity.name,
            labels: ['openrouter', 'imported', role, identity.id, identity.name],
            createdAt: message.createdAt,
            updatedAt: message.updatedAt || message.createdAt,
            embeddingModel: IMPORT_EMBEDDING_MODEL,
            transcript: {
              source: 'openrouter-json', sourceHash, sourceFile: req.file!.originalname, messageId: message.id,
              role, identityId: identity.id, identityName: identity.name, isEdited: Boolean(message.isEdited), metadata: message.metadata || {},
            },
          });
        }));
      }
      res.json({ success: true, embedded: turns.length, skippedReasoning: true, embeddingModel: IMPORT_EMBEDDING_MODEL });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  await hintPrewarmPromise;
  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Content Explorer ready at ${url}; conversation imports embed with ${IMPORT_EMBEDDING_MODEL}`);
    if (!/^(?:0|false|no)$/i.test(process.env.CONTENT_EXPLORER_OPEN_BROWSER || '')) void open(url);
  });
}

void start();
