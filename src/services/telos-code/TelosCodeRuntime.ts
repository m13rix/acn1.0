import { networkInterfaces } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import QRCode from 'qrcode';

import {
  createLibp2pTelosLinkNode,
  mapPublicTcpPort,
  type PublicPortMapping,
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

export interface TelosCodeReachability {
  state: 'lan' | 'public-candidate' | 'verified' | 'unreachable';
  lanRoute: string;
  publicRoute: string | null;
  detail: string;
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
    private readonly primaryPairingRoute: { host: string; port: number },
    private readonly fullPairingRoute: string,
    private reachability: TelosCodeReachability,
    private readonly publicMapping: PublicPortMapping | null,
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
    try {
      await created.node.start();
      const listenPort = readListenPort(created);
      const pairingHost = options.pairingHost || process.env.TELOS_CODE_PAIR_HOST || firstLanIpv4();
      const route = await resolveReachability(pairingHost, listenPort);
      let runtime: TelosCodeRuntime;
      const endpoint = new TelosCodeLinkEndpoint(created.node, threads, store, {
        harnessId,
        approveClient: options.approveClient,
        workspaceSnapshots: snapshots,
        onRouteVerified: (dialRoute) => runtime?.markRouteVerified(dialRoute),
      });
      runtime = new TelosCodeRuntime(
        created,
        endpoint,
        store,
        threads,
        harnessId,
        pairingHost,
        listenPort,
        route.primary,
        route.fullAddress,
        route.reachability,
        route.mapping,
      );
      await endpoint.start();
      return runtime;
    } catch (error) {
      await threads.terminals.close().catch(() => undefined);
      await created.node.stop().catch(() => undefined);
      store.close();
      throw error;
    }
  }

  public beginPairing(): TelosCodePairingSession {
    return this.endpoint.beginPairing({
      host: this.primaryPairingRoute.host,
      port: this.primaryPairingRoute.port,
      fullAddress: this.fullPairingRoute,
    });
  }

  public getReachability(): TelosCodeReachability {
    return { ...this.reachability };
  }

  public get threadService(): ThreadService {
    return this.threads;
  }

  public formatPairingMessage(pairing = this.beginPairing()): string {
    return [
      'Telos Code pairing code (valid for 10 minutes):',
      '',
      pairing.code,
      '',
      `Direct route: ${pairing.route.host}:${pairing.route.port}`,
      `Reachability: ${this.reachability.state} - ${this.reachability.detail}`,
      '',
      'Full/QR pairing payload:',
      pairing.fullAddress || '(unavailable)',
      '',
      'The harness will ask you to approve the laptop fingerprint after it dials.',
    ].join('\n');
  }

  public async createPairingPresentation(): Promise<{
    pairing: TelosCodePairingSession;
    message: string;
    terminalQr: string;
    qrPng: Buffer;
  }> {
    const pairing = this.beginPairing();
    const payload = pairing.fullAddress || pairing.code;
    const [terminalQr, qrPng] = await Promise.all([
      QRCode.toString(payload, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }),
      QRCode.toBuffer(payload, { type: 'png', width: 640, margin: 2, errorCorrectionLevel: 'M' }),
    ]);
    return { pairing, message: this.formatPairingMessage(pairing), terminalQr, qrPng };
  }

  public async close(): Promise<void> {
    await this.endpoint.close();
    await this.threads.terminals.close();
    await this.created.node.stop();
    await this.publicMapping?.stop().catch(() => undefined);
    this.store.close();
  }

  private markRouteVerified(route: string): void {
    if (this.reachability.publicRoute && route === this.reachability.publicRoute) {
      this.reachability = {
        ...this.reachability,
        state: 'verified',
        detail: 'A Telos Code client completed an authenticated dial through the public route.',
      };
    }
  }
}

async function resolveReachability(lanHost: string, listenPort: number): Promise<{
  primary: { host: string; port: number };
  fullAddress: string;
  reachability: TelosCodeReachability;
  mapping: PublicPortMapping | null;
}> {
  const lanRoute = `/ip4/${lanHost}/tcp/${listenPort}`;
  const configured = process.env.TELOS_CODE_PUBLIC_ROUTE?.trim();
  if (configured) {
    const route = normalizePublicRoute(configured, listenPort);
    const ipv4 = parseIpv4TcpRoute(route);
    return {
      primary: ipv4 || { host: lanHost, port: listenPort },
      fullAddress: route,
      reachability: {
        state: 'public-candidate',
        lanRoute,
        publicRoute: route,
        detail: 'Manual public route configured; it remains unverified until a client successfully dials it.',
      },
      mapping: null,
    };
  }
  if (!readBooleanEnv('TELOS_CODE_DISABLE_UPNP')) {
    try {
      const mapping = await mapPublicTcpPort(lanHost, listenPort, { timeoutMs: 3_000 });
      const endpoint = new URL(mapping.endpoint);
      const host = endpoint.hostname.replace(/^\[|\]$/gu, '');
      const port = Number(endpoint.port || listenPort);
      const fullAddress = `/ip4/${host}/tcp/${port}`;
      return {
        primary: { host, port },
        fullAddress,
        reachability: {
          state: 'public-candidate',
          lanRoute,
          publicRoute: fullAddress,
          detail: 'UPnP returned a public IPv4 route; it remains unverified until a client successfully dials it.',
        },
        mapping,
      };
    } catch (error) {
      return {
        primary: { host: lanHost, port: listenPort },
        fullAddress: lanRoute,
        reachability: {
          state: 'lan',
          lanRoute,
          publicRoute: null,
          detail: `LAN only. Public traversal unavailable: ${error instanceof Error ? error.message : String(error)}`,
        },
        mapping: null,
      };
    }
  }
  return {
    primary: { host: lanHost, port: listenPort },
    fullAddress: lanRoute,
    reachability: {
      state: 'lan',
      lanRoute,
      publicRoute: null,
      detail: 'LAN only because automatic UPnP is disabled.',
    },
    mapping: null,
  };
}

function normalizePublicRoute(value: string, defaultPort: number): string {
  if (value.startsWith('/')) return value;
  const url = value.includes('://') ? new URL(value) : new URL(`tcp://${value}`);
  const port = Number(url.port || defaultPort);
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TELOS_CODE_PUBLIC_ROUTE: ${value}`);
  }
  const family = host.includes(':') ? 'ip6' : /^\d+\.\d+\.\d+\.\d+$/u.test(host) ? 'ip4' : 'dns';
  return `/${family}/${host}/tcp/${port}`;
}

function parseIpv4TcpRoute(route: string): { host: string; port: number } | null {
  const match = /^\/ip4\/([^/]+)\/tcp\/(\d+)$/u.exec(route);
  return match ? { host: match[1]!, port: Number(match[2]) } : null;
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

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
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
