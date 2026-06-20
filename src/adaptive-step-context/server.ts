import express from 'express';
import { createServer, type Server } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { getAdaptiveStepContextService } from './Service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLIENT_DIR = join(__dirname, 'client');
const DEFAULT_PORT = 3067;

interface ServerState {
  server: Server;
  port: number;
  openedSessions: Set<string>;
}

interface EnsureOptions {
  port?: number;
  openBrowser?: boolean;
  sessionId?: string;
}

let state: ServerState | null = null;
let starting: Promise<ServerState> | null = null;

function parsePort(value: unknown): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  return DEFAULT_PORT;
}

async function startServer(port: number): Promise<ServerState> {
  const app = express();
  const server = createServer(app);
  const service = getAdaptiveStepContextService();

  app.use(express.static(CLIENT_DIR));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/sessions', (_req, res) => {
    res.json({ sessions: service.listSessions() });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = service.getSession(String(req.params.id || ''));
    if (!session) {
      res.status(404).json({ error: 'Adaptive step context session not found.' });
      return;
    }
    res.json({ session });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, port });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`Adaptive Step Context heatmap running at http://localhost:${port}`);
  return { server, port, openedSessions: new Set() };
}

export async function ensureAdaptiveStepContextServer(options: EnsureOptions = {}): Promise<string> {
  const port = parsePort(options.port ?? process.env.ADAPTIVE_STEP_CONTEXT_PORT);
  if (!state && !starting) {
    starting = startServer(port)
      .then((next) => {
        state = next;
        return next;
      })
      .catch((error: any) => {
        if (error?.code === 'EADDRINUSE') {
          console.warn(`[AdaptiveStepContext] Debug server port ${port} is already in use; continuing without starting another heatmap server.`);
          return { server: null as unknown as Server, port, openedSessions: new Set<string>() };
        }
        throw error;
      })
      .finally(() => {
        starting = null;
      });
  }

  const active = state ?? await starting!;
  const url = `http://localhost:${active.port}${options.sessionId ? `/?session=${encodeURIComponent(options.sessionId)}` : ''}`;

  if (options.openBrowser !== false && options.sessionId && !active.openedSessions.has(options.sessionId)) {
    active.openedSessions.add(options.sessionId);
    open(url).catch(() => {});
  }

  return url;
}
