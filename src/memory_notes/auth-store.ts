import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface KeepAuthProfile {
  id: string;
  provider: 'google-keep';
  email: string;
  deviceId: string;
  masterToken: string;
  createdAt: number;
  updatedAt: number;
  lastSyncAt?: number;
}

export interface KeepLoginSession {
  id: string;
  email: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
}

interface KeepAuthStoreShape {
  version: 1;
  activeProfileId?: string;
  profiles: Record<string, KeepAuthProfile>;
}

const DEFAULT_STORE: KeepAuthStoreShape = {
  version: 1,
  profiles: {},
};

export class KeepAuthStore {
  constructor(private readonly rootDir: string) {}

  get profilesPath(): string {
    return path.join(this.rootDir, 'auth-profiles.json');
  }

  get loginSessionsDir(): string {
    return path.join(this.rootDir, 'login-sessions');
  }

  get cacheDir(): string {
    return path.join(this.rootDir, 'keep-cache');
  }

  async read(): Promise<KeepAuthStoreShape> {
    try {
      const raw = await fs.readFile(this.profilesPath, 'utf8');
      return { ...DEFAULT_STORE, ...(JSON.parse(raw) as Partial<KeepAuthStoreShape>) };
    } catch {
      return { ...DEFAULT_STORE };
    }
  }

  async write(store: KeepAuthStoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.profilesPath), { recursive: true });
    await fs.writeFile(this.profilesPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  }

  async upsertProfile(profile: KeepAuthProfile): Promise<void> {
    const store = await this.read();
    store.profiles[profile.id] = profile;
    store.activeProfileId = profile.id;
    await this.write(store);
  }

  async getActiveProfile(): Promise<KeepAuthProfile | undefined> {
    const store = await this.read();
    return store.activeProfileId ? store.profiles[store.activeProfileId] : undefined;
  }

  async setActiveProfile(profileIdOrEmail: string): Promise<KeepAuthProfile> {
    const normalized = String(profileIdOrEmail || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('Profile id or email is required.');
    }

    const store = await this.read();
    const profile = Object.values(store.profiles).find(item => {
      return item.id.toLowerCase() === normalized || item.email.toLowerCase() === normalized;
    });

    if (!profile) {
      throw new Error(`Google Keep profile "${profileIdOrEmail}" was not found.`);
    }

    store.activeProfileId = profile.id;
    await this.write(store);
    return profile;
  }

  async removeProfile(profileIdOrEmail?: string): Promise<void> {
    const store = await this.read();
    const target = String(profileIdOrEmail || store.activeProfileId || '').trim().toLowerCase();
    if (!target) {
      return;
    }

    const found = Object.values(store.profiles).find(item => {
      return item.id.toLowerCase() === target || item.email.toLowerCase() === target;
    });

    if (!found) {
      return;
    }

    delete store.profiles[found.id];
    if (store.activeProfileId === found.id) {
      store.activeProfileId = Object.keys(store.profiles)[0];
    }

    await this.write(store);
    await fs.rm(this.getStatePath(found.id), { force: true }).catch(() => {});
  }

  getStatePath(profileId: string): string {
    const safe = profileId.replace(/[:@<>"|?*\\/]/g, '_');
    return path.join(this.cacheDir, `${safe}.json`);
  }

  async createLoginSession(session: KeepLoginSession): Promise<void> {
    await fs.mkdir(this.loginSessionsDir, { recursive: true });
    const target = path.join(this.loginSessionsDir, `${session.id}.json`);
    await fs.writeFile(target, JSON.stringify(session, null, 2) + '\n', 'utf8');
  }

  async getLoginSession(loginId: string): Promise<KeepLoginSession | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.loginSessionsDir, `${loginId}.json`), 'utf8');
      return JSON.parse(raw) as KeepLoginSession;
    } catch {
      return undefined;
    }
  }

  async deleteLoginSession(loginId: string): Promise<void> {
    await fs.unlink(path.join(this.loginSessionsDir, `${loginId}.json`)).catch(() => {});
  }
}
