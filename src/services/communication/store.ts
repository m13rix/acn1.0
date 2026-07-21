import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import type {
  TelosAckInput,
  TelosCommunicationState,
  TelosDeviceRecord,
  TelosDeviceRegistration,
  TelosEventAckStatus,
  TelosEventRecord,
  TelosPublishInput,
} from './types.js';

const STATE_VERSION = 1;
const DEFAULT_MAX_EVENTS = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function emptyState(): TelosCommunicationState {
  return {
    version: STATE_VERSION,
    nextSequence: 1,
    devices: {},
    events: [],
  };
}

function normalizeState(raw: Partial<TelosCommunicationState> | null | undefined): TelosCommunicationState {
  return {
    version: STATE_VERSION,
    nextSequence: Math.max(1, Math.floor(Number(raw?.nextSequence) || 1)),
    devices: raw?.devices ?? {},
    events: Array.isArray(raw?.events) ? raw.events as TelosEventRecord[] : [],
  };
}

export class TelosCommunicationStore {
  private state = emptyState();
  private saveQueue = Promise.resolve();
  private readonly statePath: string;
  private readonly maxEvents: number;

  constructor(private readonly dataDir: string, options: { maxEvents?: number } = {}) {
    this.statePath = path.join(dataDir, 'communication-state.json');
    this.maxEvents = Math.max(100, Math.floor(options.maxEvents || DEFAULT_MAX_EVENTS));
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    if (!existsSync(this.statePath)) {
      this.state = emptyState();
      await this.save();
      return;
    }
    this.state = normalizeState(JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<TelosCommunicationState>);
  }

  getStateSnapshot(): TelosCommunicationState {
    return JSON.parse(JSON.stringify(this.state)) as TelosCommunicationState;
  }

  listDevices(): TelosDeviceRecord[] {
    return Object.values(this.state.devices).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  getDevice(deviceId: string): TelosDeviceRecord | undefined {
    return this.state.devices[deviceId];
  }

  async registerDevice(input: TelosDeviceRegistration): Promise<TelosDeviceRecord> {
    const deviceId = String(input.deviceId || '').trim();
    if (!deviceId) {
      throw new Error('deviceId is required.');
    }
    const timestamp = nowIso();
    const previous = this.state.devices[deviceId];
    const record: TelosDeviceRecord = {
      ...previous,
      ...input,
      deviceId,
      platform: input.platform || previous?.platform || 'unknown',
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.state.devices[deviceId] = record;
    await this.save();
    return { ...record };
  }

  async touchDevice(deviceId: string): Promise<void> {
    const device = this.state.devices[deviceId];
    if (!device) {
      return;
    }
    device.lastSeenAt = nowIso();
    device.updatedAt = device.updatedAt || device.lastSeenAt;
    await this.save();
  }

  async publish<TPayload>(input: TelosPublishInput<TPayload>): Promise<TelosEventRecord<TPayload>> {
    const timestamp = nowIso();
    const sequence = this.state.nextSequence++;
    const event: TelosEventRecord<TPayload> = {
      id: eventId(),
      sequence,
      type: input.type,
      priority: input.priority || 'normal',
      createdAt: timestamp,
      expiresAt: input.ttlMs ? new Date(Date.now() + input.ttlMs).toISOString() : undefined,
      source: input.source,
      conversationId: input.conversationId,
      target: input.target || { broadcast: true },
      payload: input.payload,
      delivery: {},
    };
    this.state.events.push(event as TelosEventRecord);
    if (this.state.events.length > this.maxEvents) {
      this.state.events.splice(0, this.state.events.length - this.maxEvents);
    }
    await this.save();
    return JSON.parse(JSON.stringify(event)) as TelosEventRecord<TPayload>;
  }

  listEvents(input: {
    deviceId?: string;
    since?: number;
    limit?: number;
    includeExpired?: boolean;
  } = {}): TelosEventRecord[] {
    const since = Math.max(0, Math.floor(Number(input.since) || 0));
    const limit = Math.max(1, Math.min(500, Math.floor(Number(input.limit) || 100)));
    const now = Date.now();
    return this.state.events
      .filter((event) => event.sequence > since)
      .filter((event) => input.includeExpired || !event.expiresAt || new Date(event.expiresAt).getTime() > now)
      .filter((event) => !input.deviceId || this.targetsDevice(event, input.deviceId))
      .slice(0, limit)
      .map((event) => JSON.parse(JSON.stringify(event)) as TelosEventRecord);
  }

  async ack(input: TelosAckInput): Promise<TelosEventRecord[]> {
    const status: TelosEventAckStatus = input.status || 'delivered';
    const eventIds = new Set(input.eventIds || []);
    const updated: TelosEventRecord[] = [];
    for (const event of this.state.events) {
      const matchesId = eventIds.size > 0 && eventIds.has(event.id);
      const matchesSequence = input.throughSequence !== undefined && event.sequence <= input.throughSequence;
      if (!matchesId && !matchesSequence) {
        continue;
      }
      if (!this.targetsDevice(event, input.deviceId)) {
        continue;
      }
      event.delivery[input.deviceId] = status;
      updated.push(JSON.parse(JSON.stringify(event)) as TelosEventRecord);
    }
    await this.touchDevice(input.deviceId);
    if (updated.length > 0) {
      await this.save();
    }
    return updated;
  }

  resolveTargetDevices(event: TelosEventRecord): TelosDeviceRecord[] {
    return this.listDevices().filter((device) => this.targetsDevice(event, device.deviceId));
  }

  private targetsDevice(event: TelosEventRecord, deviceId: string): boolean {
    const device = this.state.devices[deviceId];
    if (!device) {
      return event.target.deviceIds?.includes(deviceId) === true;
    }
    return event.target.broadcast === true
      || event.target.deviceIds?.includes(device.deviceId) === true
      || (!!device.appId && event.target.appIds?.includes(device.appId) === true)
      || (!!device.userId && event.target.userIds?.includes(device.userId) === true);
  }

  private async save(): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      const tmp = `${this.statePath}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      await rename(tmp, this.statePath);
    });
    return this.saveQueue;
  }
}
