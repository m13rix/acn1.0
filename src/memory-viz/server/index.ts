import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdir, writeFile } from 'fs/promises';
import open from 'open';
import { MemoryService } from '../../memory_system/MemoryService.js';
import { DEFAULT_MEMORY_CONFIG } from '../../memory_system/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const UPLOADS_DIR = join(PROJECT_ROOT, 'data', 'memory', 'uploads');

const PORT = 3000; // You might want to make this dynamic or configurable
const CLIENT_DIR = join(__dirname, '../client');

async function startServer() {
    const app = express();
    const server = createServer(app);

    // Initialize Memory Service
    // We use default config here, assuming it connects to the same LanceDB path
    const memory = new MemoryService(DEFAULT_MEMORY_CONFIG);
    try {
        await memory.initialize();
        console.log('Connected to Memory Service');
    } catch (err) {
        console.error('Failed to connect to Memory Service:', err);
        process.exit(1);
    }

    // Serve static files
    app.use(express.static(CLIENT_DIR));
    app.use(express.json({ limit: '20mb' }));

    // API Endpoint for Graph Data
    app.get('/api/data', async (req, res) => {
        try {
            const facts = await memory.getAllFacts();
            const links = await memory.getAllLinks();

            // Transform for frontend if necessary, or send as is
            // Sending as is for now, frontend can handle processing
            res.json({
                nodes: facts.map(f => ({
                    id: f.id,
                    text: f.text,
                    confidence: f.confidence,
                    topics: f.topics,
                    embedding: f.embedding // Sending embedding for PCA/Clustering on client
                })),
                links: links.map(l => ({
                    source: l.fromFactId,
                    target: l.toFactId,
                    relation: l.relation,
                    confidence: l.confidence,
                    isManual: l.isManual
                }))
            });
        } catch (error) {
            console.error('Error fetching data:', error);
            res.status(500).json({ error: 'Failed to fetch memory data' });
        }
    });

    app.post('/api/add-doc', async (req, res) => {
        try {
            const filename = String(req.body?.filename ?? '').trim();
            const content = String(req.body?.content ?? '');
            if (!filename) {
                res.status(400).json({ error: 'filename is required' });
                return;
            }
            if (!content.trim()) {
                res.status(400).json({ error: 'content is empty' });
                return;
            }

            const ext = filename.toLowerCase().endsWith('.md') ? '.md'
                : filename.toLowerCase().endsWith('.txt') ? '.txt'
                : '';
            if (!ext) {
                res.status(400).json({ error: 'Only .md or .txt files are supported' });
                return;
            }

            // Keep only safe filename chars to avoid traversal/injection.
            const safeBase = filename
                .replace(/[^\w.\- ]/g, '_')
                .replace(/\s+/g, '_')
                .slice(0, 80);
            const finalBase = safeBase.endsWith(ext) ? safeBase : `${safeBase}${ext}`;
            const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${finalBase}`;
            const absolutePath = join(UPLOADS_DIR, uniqueName);
            const relativePath = `./data/memory/uploads/${uniqueName}`;

            await mkdir(UPLOADS_DIR, { recursive: true });
            await writeFile(absolutePath, content, 'utf8');

            const result = await memory.addDoc(relativePath);
            res.json({ ok: true, result, savedPath: relativePath });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to import document';
            console.error('Error in /api/add-doc:', error);
            res.status(500).json({ error: message });
        }
    });

    app.post('/api/search', async (req, res) => {
        try {
            const query = String(req.body?.query ?? '').trim();
            if (!query) {
                res.status(400).json({ error: 'query is required' });
                return;
            }

            const optionsRaw = req.body?.options ?? {};
            const options: {
                maxDepth?: number;
                maxStartFacts?: number;
                maxChains?: number;
                beamWidth?: number;
            } = {};

            const addIntOption = (key: 'maxDepth' | 'maxStartFacts' | 'maxChains' | 'beamWidth') => {
                const value = optionsRaw?.[key];
                if (typeof value !== 'number' || !Number.isFinite(value)) return;
                options[key] = Math.max(1, Math.floor(value));
            };
            addIntOption('maxDepth');
            addIntOption('maxStartFacts');
            addIntOption('maxChains');
            addIntOption('beamWidth');

            const output = await memory.search(query, options);
            const chains = output
                .split(/\r?\n/g)
                .map((line) => line.trim())
                .filter(Boolean);

            res.json({
                ok: true,
                query,
                chains,
                text: output,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Search failed';
            console.error('Error in /api/search:', error);
            res.status(500).json({ error: message });
        }
    });

    server.listen(PORT, async () => {
        const url = `http://localhost:${PORT}`;
        console.log(`Memory Visualizer running at ${url}`);
        await open(url);
    });
}

startServer().catch(console.error);
