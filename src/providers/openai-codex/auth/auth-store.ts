import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuthStoreShape, LoginSessionRecord, OAuthProfile } from './auth-types.js';

const DEFAULT_STORE: AuthStoreShape = {
  version: 1,
  activeProfiles: {},
  profiles: {},
};

export class OpenAICodexAuthStore {
  constructor(private readonly rootDir: string) {}

  get profilesPath(): string {
    return path.join(this.rootDir, 'auth-profiles.json');
  }

  get refreshLockPath(): string {
    return path.join(this.rootDir, 'refresh.lock');
  }

  get loginSessionsDir(): string {
    return path.join(this.rootDir, 'login-sessions');
  }

  async read(): Promise<AuthStoreShape> {
    try {
      const raw = await fs.readFile(this.profilesPath, 'utf8');
      return { ...DEFAULT_STORE, ...(JSON.parse(raw) as AuthStoreShape) };
    } catch {
      return { ...DEFAULT_STORE };
    }
  }

  async write(data: AuthStoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.profilesPath), { recursive: true });
    await fs.writeFile(this.profilesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  async upsertProfile(profile: OAuthProfile): Promise<void> {
    const store = await this.read();
    store.profiles[profile.id] = profile;
    store.activeProfiles['openai-codex'] = profile.id;
    await this.write(store);
  }

  async listProfiles(): Promise<OAuthProfile[]> {
    const store = await this.read();
    return Object.values(store.profiles).filter((item): item is OAuthProfile => Boolean(item));
  }

  async getActiveProfile(): Promise<OAuthProfile | undefined> {
    const store = await this.read();
    const profileId = store.activeProfiles['openai-codex'];
    return profileId ? store.profiles[profileId] : undefined;
  }

  async setActiveProfile(profileId: string): Promise<void> {
    const store = await this.read();
    store.activeProfiles['openai-codex'] = profileId;
    await this.write(store);
  }

  async removeProfile(profileId: string): Promise<void> {
    const store = await this.read();
    delete store.profiles[profileId];
    if (store.activeProfiles['openai-codex'] === profileId) {
      const nextProfile = Object.keys(store.profiles)[0];
      store.activeProfiles['openai-codex'] = nextProfile;
    }
    await this.write(store);
  }

  async createLoginSession(record: LoginSessionRecord): Promise<void> {
    await fs.mkdir(this.loginSessionsDir, { recursive: true });
    const target = path.join(this.loginSessionsDir, `${record.id}.json`);
    await fs.writeFile(target, JSON.stringify(record, null, 2) + '\n', 'utf8');
  }

  async getLoginSession(loginId: string): Promise<LoginSessionRecord | undefined> {
    try {
      const raw = await fs.readFile(path.join(this.loginSessionsDir, `${loginId}.json`), 'utf8');
      return JSON.parse(raw) as LoginSessionRecord;
    } catch {
      return undefined;
    }
  }

  async deleteLoginSession(loginId: string): Promise<void> {
    await fs.unlink(path.join(this.loginSessionsDir, `${loginId}.json`)).catch(() => {});
  }
}
