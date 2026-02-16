import express from 'express';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { MemoryService } from '../../memory_system/MemoryService.js';
import { DEFAULT_MEMORY_CONFIG } from '../../memory_system/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

    server.listen(PORT, async () => {
        const url = `http://localhost:${PORT}`;
        console.log(`Memory Visualizer running at ${url}`);
        await open(url);
    });
}

startServer().catch(console.error);
