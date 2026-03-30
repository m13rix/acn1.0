import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import type { InterfaceUiEventPayload } from './base.js';
import { getInterfaceRouteRegistry } from './registry.js';

interface RouteResolution {
  handlerRouteId: string;
}

function normalizeRouteId(routeId: string): string {
  return String(routeId || '').trim();
}

export class InterfaceBridgeServer {
  private readonly app = express();
  private server: Server | null = null;
  private apiUrl = '';

  constructor() {
    this.app.use(express.json({ limit: '2mb' }));
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.post('/api/ask', async (req, res): Promise<void> => {
      const { routeId, chatId, question, agentName } = req.body as {
        routeId?: string;
        chatId?: string;
        question?: string;
        agentName?: string;
      };

      const resolved = this.resolveRoute(routeId || chatId);
      if (!resolved || !question) {
        res.status(400).json({ error: 'Missing routeId/question parameters' });
        return;
      }

      try {
        const handler = this.requireHandler(resolved.handlerRouteId);
        const response = await handler.ask(question, agentName);
        res.json({ status: 'answered', response });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/sendFiles', async (req, res): Promise<void> => {
      const { routeId, chatId, files, agentName } = req.body as {
        routeId?: string;
        chatId?: string;
        files?: string[];
        agentName?: string;
      };
      const resolved = this.resolveRoute(routeId || chatId);
      if (!resolved || !Array.isArray(files)) {
        res.status(400).json({ error: 'Missing routeId/files parameters' });
        return;
      }

      try {
        const handler = this.requireHandler(resolved.handlerRouteId);
        await handler.sendFiles(files, agentName);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/sendVoice', async (req, res): Promise<void> => {
      const { routeId, chatId, file, agentName } = req.body as {
        routeId?: string;
        chatId?: string;
        file?: string;
        agentName?: string;
      };
      const resolved = this.resolveRoute(routeId || chatId);
      if (!resolved || !file) {
        res.status(400).json({ error: 'Missing routeId/file parameters' });
        return;
      }

      try {
        const handler = this.requireHandler(resolved.handlerRouteId);
        await handler.sendVoice(file, agentName);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/sendText', async (req, res): Promise<void> => {
      const { routeId, chatId, text, agentName } = req.body as {
        routeId?: string;
        chatId?: string;
        text?: string;
        agentName?: string;
      };
      const resolved = this.resolveRoute(routeId || chatId);
      if (!resolved || !text) {
        res.status(400).json({ error: 'Missing routeId/text parameters' });
        return;
      }

      try {
        const handler = this.requireHandler(resolved.handlerRouteId);
        await handler.sendText(text, agentName);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/sendAuthLink', async (req, res): Promise<void> => {
      const { routeId, chatId, text, url, label, agentName } = req.body as {
        routeId?: string;
        chatId?: string;
        text?: string;
        url?: string;
        label?: string;
        agentName?: string;
      };
      const resolved = this.resolveRoute(routeId || chatId);
      if (!resolved || !text || !url) {
        res.status(400).json({ error: 'Missing routeId/text/url parameters' });
        return;
      }

      try {
        const handler = this.requireHandler(resolved.handlerRouteId);
        if (!handler.sendAuthLink) {
          throw new Error(`Interface "${handler.interfaceName}" does not support auth links.`);
        }
        await handler.sendAuthLink(text, url, label, agentName);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/api/ui/event', async (req, res): Promise<void> => {
      const payload = req.body as InterfaceUiEventPayload & {
        routeId?: string;
        chatId?: string;
      };
      const resolved = this.resolveRoute(payload.routeId || payload.chatId);
      if (!resolved || !payload.event || !payload.scopeId) {
        res.status(400).json({ error: 'Missing routeId/event/scopeId parameters' });
        return;
      }

      try {
        const handler = this.requireHandler(resolved.handlerRouteId);
        if (!handler.emitUiEvent) {
          throw new Error(`Interface "${handler.interfaceName}" does not support UI events.`);
        }
        await handler.emitUiEvent(payload);
        res.json({ success: true });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  private resolveRoute(candidateRouteId?: string): RouteResolution | null {
    const routeId = normalizeRouteId(candidateRouteId || '');
    if (!routeId) {
      return null;
    }

    const registry = getInterfaceRouteRegistry();
    if (registry.get(routeId)) {
      return { handlerRouteId: routeId };
    }

    return null;
  }

  private requireHandler(routeId: string) {
    const handler = getInterfaceRouteRegistry().get(routeId);
    if (!handler) {
      throw new Error(`No interface route handler registered for "${routeId}".`);
    }
    return handler;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(0, () => {
        const address = this.server?.address() as AddressInfo;
        this.apiUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    this.server = null;
    this.apiUrl = '';
  }

  getApiUrl(): string {
    return this.apiUrl;
  }
}
