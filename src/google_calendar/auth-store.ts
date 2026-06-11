import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface GoogleCalendarOAuthClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
  updatedAt: number;
}

export interface GoogleCalendarProfile {
  id: string;
  provider: 'google-calendar';
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  email?: string;
  displayName?: string;
  expiresAt?: number;
  scopes: string[];
  createdAt: number;
  updatedAt: number;
}

interface GoogleCalendarAuthStoreShape {
  version: 1;
  activeProfileId?: string;
  profiles: Record<string, GoogleCalendarProfile>;
}

const DEFAULT_STORE: GoogleCalendarAuthStoreShape = {
  version: 1,
  profiles: {},
};

export class GoogleCalendarAuthStore {
  constructor(private readonly rootDir: string) {}

  get profilesPath(): string {
    return path.join(this.rootDir, 'auth-profiles.json');
  }

  get clientConfigPath(): string {
    return path.join(this.rootDir, 'oauth-client.json');
  }

  async read(): Promise<GoogleCalendarAuthStoreShape> {
    try {
      const raw = await fs.readFile(this.profilesPath, 'utf8');
      return { ...DEFAULT_STORE, ...(JSON.parse(raw) as GoogleCalendarAuthStoreShape) };
    } catch {
      return { ...DEFAULT_STORE };
    }
  }

  async write(store: GoogleCalendarAuthStoreShape): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.profilesPath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  }

  async upsertProfile(profile: GoogleCalendarProfile): Promise<void> {
    const store = await this.read();
    store.profiles[profile.id] = profile;
    store.activeProfileId = profile.id;
    await this.write(store);
  }

  async listProfiles(): Promise<GoogleCalendarProfile[]> {
    const store = await this.read();
    return Object.values(store.profiles);
  }

  async getActiveProfile(): Promise<GoogleCalendarProfile | undefined> {
    const store = await this.read();
    return store.activeProfileId ? store.profiles[store.activeProfileId] : undefined;
  }

  async setActiveProfile(profileIdOrEmail: string): Promise<GoogleCalendarProfile> {
    const normalized = String(profileIdOrEmail || '').trim().toLowerCase();
    if (!normalized) {
      throw new Error('Profile id or email is required.');
    }

    const store = await this.read();
    const profile = Object.values(store.profiles).find((item) => {
      return item.id.toLowerCase() === normalized || (item.email || '').toLowerCase() === normalized;
    });

    if (!profile) {
      throw new Error(`Google Calendar profile "${profileIdOrEmail}" was not found.`);
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

    const found = Object.values(store.profiles).find((item) => {
      return item.id.toLowerCase() === target || (item.email || '').toLowerCase() === target;
    });
    if (!found) {
      return;
    }

    delete store.profiles[found.id];
    if (store.activeProfileId === found.id) {
      store.activeProfileId = Object.keys(store.profiles)[0];
    }
    await this.write(store);
  }

  async readClientConfig(): Promise<GoogleCalendarOAuthClientConfig | undefined> {
    try {
      const raw = await fs.readFile(this.clientConfigPath, 'utf8');
      return JSON.parse(raw) as GoogleCalendarOAuthClientConfig;
    } catch {
      return undefined;
    }
  }

  async writeClientConfig(config: GoogleCalendarOAuthClientConfig): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    await fs.writeFile(this.clientConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  }
}
