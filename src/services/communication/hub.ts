import type express from 'express';
import type { Server } from 'http';
import WebSocket, { WebSocketServer } from 'ws';

import { FcmSender } from './fcm.js';
import { TelosCommunicationStore } from './store.js';
import type {
  TelosAckInput,
  TelosDeviceRegistration,
  TelosEventRecord,
  TelosPublishInput,
} from './types.js';

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredAuthToken(): string {
  return (process.env.TELOS_COMM_AUTH_TOKEN || '').trim();
}

function requestToken(req: express.Request): string {
  const auth = req.header('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  return (req.header('x-telos-comm-token') || '').trim();
}

export class TelosCommunicationHub {
  private readonly store: TelosCommunicationStore;
  private readonly fcm = new FcmSender();
  private websocketServer: WebSocketServer | null = null;
  private readonly sockets = new Map<string, Set<WebSocket>>();

  constructor(dataDir: string) {
    this.store = new TelosCommunicationStore(dataDir);
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  close(): void {
    this.websocketServer?.close();
    this.websocketServer = null;
    for (const sockets of this.sockets.values()) {
      for (const socket of sockets) {
        socket.close();
      }
    }
    this.sockets.clear();
  }

  mount(app: express.Express): void {
    const requireAuth: express.RequestHandler = (req, res, next) => {
      const expected = configuredAuthToken();
      if (!expected || requestToken(req) === expected) {
        next();
        return;
      }
      res.status(401).json({ success: false, error: 'Unauthorized communication request.' });
    };

    app.get('/v1/comm/health', async (_req, res) => {
      res.json({
        success: true,
        fcmConfigured: await this.fcm.isConfigured(),
        authRequired: !!configuredAuthToken(),
        devices: this.store.listDevices().length,
      });
    });

    app.post('/v1/comm/devices/register', requireAuth, async (req, res): Promise<void> => {
      try {
        const device = await this.registerDevice(req.body as TelosDeviceRegistration);
        res.json({ success: true, device });
      } catch (error) {
        res.status(400).json({ success: false, error: jsonError(error) });
      }
    });

    app.get('/v1/comm/devices', requireAuth, (_req, res) => {
      res.json({ success: true, devices: this.store.listDevices() });
    });

    app.get('/v1/comm/events', requireAuth, (req, res) => {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : undefined;
      const since = Number(req.query.since);
      const limit = Number(req.query.limit);
      res.json({
        success: true,
        events: this.store.listEvents({
          deviceId,
          since: Number.isFinite(since) ? since : undefined,
          limit: Number.isFinite(limit) ? limit : undefined,
        }),
      });
    });

    app.post('/v1/comm/events/ack', requireAuth, async (req, res): Promise<void> => {
      try {
        const updated = await this.ack(req.body as TelosAckInput);
        res.json({ success: true, updated });
      } catch (error) {
        res.status(400).json({ success: false, error: jsonError(error) });
      }
    });

    app.post('/v1/comm/events', requireAuth, async (req, res): Promise<void> => {
      try {
        const event = await this.publish(req.body as TelosPublishInput);
        res.json({ success: true, event });
      } catch (error) {
        res.status(400).json({ success: false, error: jsonError(error) });
      }
    });
  }

  attachWebSocket(server: Server): void {
    if (this.websocketServer) {
      return;
    }
    this.websocketServer = new WebSocketServer({ server, path: '/v1/comm/live' });
    this.websocketServer.on('connection', (socket, request) => {
      const url = new URL(request.url || '', 'http://localhost');
      const expected = configuredAuthToken();
      const token = url.searchParams.get('token') || request.headers['x-telos-comm-token'];
      const normalizedToken = Array.isArray(token) ? token[0] : token;
      if (expected && normalizedToken !== expected) {
        socket.close(1008, 'unauthorized');
        return;
      }
      const deviceId = url.searchParams.get('deviceId')?.trim();
      if (!deviceId) {
        socket.close(1008, 'deviceId is required');
        return;
      }
      let sockets = this.sockets.get(deviceId);
      if (!sockets) {
        sockets = new Set();
        this.sockets.set(deviceId, sockets);
      }
      sockets.add(socket);
      void this.store.touchDevice(deviceId);
      socket.send(JSON.stringify({ type: 'comm.connected', deviceId }));
      socket.on('message', (data) => {
        void this.handleSocketMessage(deviceId, data);
      });
      socket.on('close', () => {
        sockets?.delete(socket);
        if (sockets?.size === 0) {
          this.sockets.delete(deviceId);
        }
      });
    });
  }

  async registerDevice(input: TelosDeviceRegistration) {
    return this.store.registerDevice(input);
  }

  async publish<TPayload>(input: TelosPublishInput<TPayload>): Promise<TelosEventRecord<TPayload>> {
    const event = await this.store.publish(input);
    await this.deliver(event);
    return event;
  }

  async ack(input: TelosAckInput): Promise<TelosEventRecord[]> {
    if (!input.deviceId?.trim()) {
      throw new Error('deviceId is required.');
    }
    return this.store.ack(input);
  }

  listEvents(input: { deviceId?: string; since?: number; limit?: number } = {}): TelosEventRecord[] {
    return this.store.listEvents(input);
  }

  private async deliver(event: TelosEventRecord): Promise<void> {
    const devices = this.store.resolveTargetDevices(event);
    for (const device of devices) {
      const sockets = this.sockets.get(device.deviceId);
      if (sockets) {
        for (const socket of sockets) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'comm.event', event }));
          }
        }
      }
      if (device.fcmToken) {
        this.fcm.sendEvent(device, event).catch((error) => {
          console.warn(`[comm] FCM delivery failed for ${device.deviceId}: ${jsonError(error)}`);
        });
      }
    }
  }

  private async handleSocketMessage(deviceId: string, data: WebSocket.RawData): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    const message = parsed as { type?: string; eventIds?: string[]; throughSequence?: number; status?: TelosAckInput['status'] };
    if (message.type === 'comm.ack') {
      await this.ack({
        deviceId,
        eventIds: message.eventIds,
        throughSequence: message.throughSequence,
        status: message.status,
      });
    }
  }
}

export type { TelosPublishInput, TelosEventRecord } from './types.js';
