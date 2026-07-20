import { networkInterfaces } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';

import {
  createLibp2pTelosLinkNode,
  type CreatedLibp2pTelosLinkNode,
} from '@telos/link-node';

import { ThreadService } from '../ThreadService.js';
import { ThreadStore } from '../thread-store/ThreadStore.js';
import { WorkspaceSnapshotService } from '../WorkspaceSnapshotService.js';
import {
  TelosCodeLinkEndpoint,
  type TelosCodeClientApproval,
  type TelosCodePairingSession,
} from './TelosCodeLinkEndpoint.js';

export interface TelosCodeRuntimeOptions {
  dataDirectory?: string;
  legacySessionsPath?: string;
  listenPort?: number;
  pairingHost?: string;
  approveClient(request: TelosCodeClientApproval): boolean | Promise<boolean>;
}

export class TelosCodeRuntime {
  private constructor(
    private readonly created: CreatedLibp2pTelosLinkNode,
    private readonly endpoint: TelosCodeLinkEndpoint,
    private readonly store: ThreadStore,
    private readonly threads: ThreadService,
    readonly harnessId: string,
    readonly pairingHost: string,
    readonly listenPort: number,
  ) {}

  public static async start(options: TelosCodeRuntimeOptions): Promise<TelosCodeRuntime> {
    const dataDirectory = resolve(options.dataDirectory || join(process.cwd(), 'data', 'telos-code'));
    await mkdir(dataDirectory, { recursive: true });
    const harnessId = await loadHarnessId(join(dataDirectory, 'harness-id'));
    const store = await ThreadStore.open({
      databasePath: join(dataDirectory, 'threads.db'),
      legacySessionsPath: options.legacySessionsPath || join(process.cwd(), 'data', 'chat-sessions'),
      defaultWorkspacePath: process.cwd(),
    });
    const migration = await store.migrateLegacySessions();
    if (migration.importedThreads || migration.skipped.length) {
      console.log(
        `[telos-code] legacy migration imported ${migration.importedThreads} thread(s) and skipped ${migration.skipped.length} file(s)`,
      );
    }
    const snapshots = new WorkspaceSnapshotService(store, join(dataDirectory, 'workspace-snapshots'));
    const threads = new ThreadService(store, {
      workspaceSnapshots: snapshots,
      attachmentStoragePath: join(dataDirectory, 'attachments'),
    });
    const requestedPort = options.listenPort ?? readPort(process.env.TELOS_CODE_PORT, 4424);
    const created = await createLibp2pTelosLinkNode({
      storagePath: join(dataDirectory, 'link'),
      device: { name: 'Telos Harness', type: 'server' },
      libp2p: {
        listen: [`/ip4/0.0.0.0/tcp/${requestedPort}`],
        enableWebSockets: false,
        enableDht: false,
        enableCircuitRelayTransport: false,
        enableCircuitRelayServer: false,
        enableDcutr: false,
      },
    });
    const endpoint = new TelosCodeLinkEndpoint(created.node, threads, store, {
      harnessId,
      approveClient: options.approveClient,
      workspaceSnapshots: snapshots,
    });
    try {
      await endpoint.start();
      await created.node.start();
      const listenPort = readListenPort(created);
      const pairingHost = options.pairingHost || process.env.TELOS_CODE_PAIR_HOST || firstLanIpv4();
      return new TelosCodeRuntime(created, endpoint, store, threads, harnessId, pairingHost, listenPort);
    } catch (error) {
      await endpoint.close().catch(() => undefined);
      await threads.terminals.close().catch(() => undefined);
      await created.node.stop().catch(() => undefined);
      store.close();
      throw error;
    }
  }

  public beginPairing(): TelosCodePairingSession {
    return this.endpoint.beginPairing({
      host: this.pairingHost,
      port: this.listenPort,
      fullAddress: `/ip4/${this.pairingHost}/tcp/${this.listenPort}`,
    });
  }

  public formatPairingMessage(pairing = this.beginPairing()): string {
    return [
      'Telos Code pairing code (valid for 10 minutes):',
      '',
      pairing.code,
      '',
      `Direct route: ${pairing.route.host}:${pairing.route.port}`,
      'The harness will ask you to approve the laptop fingerprint after it dials.',
    ].join('\n');
  }

  public async close(): Promise<void> {
    await this.endpoint.close();
    await this.threads.terminals.close();
    await this.created.node.stop();
    this.store.close();
  }
}

async function loadHarnessId(path: string): Promise<string> {
  try {
    const existing = (await readFile(path, 'utf8')).trim();
    if (!isUuidV7(existing)) throw new Error(`Invalid persisted Telos harness identity: ${path}`);
    return existing;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const id = uuidv7();
  try {
    await writeFile(path, `${id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return id;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = (await readFile(path, 'utf8')).trim();
    if (!isUuidV7(existing)) throw new Error(`Invalid persisted Telos harness identity: ${path}`);
    return existing;
  }
}

function readListenPort(created: CreatedLibp2pTelosLinkNode): number {
  for (const address of created.libp2p.getMultiaddrs()) {
    const match = /\/tcp\/(\d+)(?:\/|$)/u.exec(address);
    if (match) return Number(match[1]);
  }
  throw new Error('Telos Code transport did not expose a TCP listen address.');
}

function firstLanIpv4(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return '127.0.0.1';
}

function readPort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid TELOS_CODE_PORT: ${value}`);
  }
  return parsed;
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
