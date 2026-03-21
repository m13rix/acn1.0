import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Message,
  ProviderAuthChallenge,
  ProviderAuthCompletion,
  ProviderAuthStatus,
  ProviderConfig,
  ProviderResponse,
  ProviderStreamEvent,
  ProviderToolRequest,
  ProviderToolResponse,
} from '../../types/index.js';
import { actionContext } from '../../core/ActionContext.js';
import { BaseProvider, registerProvider } from '../base.js';
import { OpenAICodexAuthStore } from './auth/auth-store.js';
import { startOAuthCallbackServer, type OAuthCallbackWaiter } from './auth/callback-server.js';
import { openAuthUrlInBrowser } from './auth/browser.js';
import {
  askTelegramForRedirectUrl,
  beginLoginSession,
  completeLoginSession,
  isTelegramAuthContext,
  notifyTelegramAboutLogin,
  promptConsoleForRedirectUrl,
} from './auth/login.js';
import { getValidProfile } from './auth/refresh.js';
import type { OAuthProfile } from './auth/auth-types.js';
import {
  CodexTransportFailedError,
  OAuthCallbackTimeoutError,
  SubscriptionAuthRequiredError,
  TokenRefreshFailedError,
} from './errors.js';
import { buildCodexRequest } from './invoke.js';
import { OPENAI_CODEX_DEFAULT_MODEL, OPENAI_CODEX_MODELS, resolveOpenAICodexModel } from './models.js';
import { SseCodexTransport, type CodexTransport } from './transport.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_DATA_DIR = path.join(PROJECT_ROOT, 'data', 'providers', 'openai-codex');
const DEFAULT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const DEFAULT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const DEFAULT_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_CLIENT_ID = process.env.OPENAI_CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_ORIGINATOR = process.env.OPENAI_CODEX_ORIGINATOR || 'codex_cli_rs';

interface OpenAICodexProviderConfig {
  dataDir: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  endpoint: string;
  clientId: string;
  originator: string;
  allowedWorkspaceId?: string;
}

interface CallbackSession {
  waiter: OAuthCallbackWaiter;
}

interface OpenAICodexProviderDeps {
  authStore?: OpenAICodexAuthStore;
  transport?: CodexTransport;
  fetchImpl?: typeof fetch;
}

export class OpenAICodexProvider extends BaseProvider {
  name = 'openai-codex';

  private readonly config: OpenAICodexProviderConfig;
  private readonly authStore: OpenAICodexAuthStore;
  private readonly transport: CodexTransport;
  private readonly fetchImpl: typeof fetch;
  private readonly callbackSessions = new Map<string, CallbackSession>();

  constructor(config?: Partial<OpenAICodexProviderConfig>, deps?: OpenAICodexProviderDeps) {
    super();
    this.config = {
      dataDir: config?.dataDir || DEFAULT_DATA_DIR,
      authorizeUrl: config?.authorizeUrl || process.env.OPENAI_CODEX_AUTHORIZE_URL || DEFAULT_AUTHORIZE_URL,
      tokenUrl: config?.tokenUrl || process.env.OPENAI_CODEX_TOKEN_URL || DEFAULT_TOKEN_URL,
      redirectUri: config?.redirectUri || process.env.OPENAI_CODEX_REDIRECT_URI || DEFAULT_REDIRECT_URI,
      endpoint: config?.endpoint || process.env.OPENAI_CODEX_ENDPOINT || DEFAULT_ENDPOINT,
      clientId: config?.clientId || DEFAULT_CLIENT_ID,
      originator: config?.originator || DEFAULT_ORIGINATOR,
      allowedWorkspaceId: config?.allowedWorkspaceId || process.env.OPENAI_CODEX_ALLOWED_WORKSPACE_ID,
    };
    this.authStore = deps?.authStore || new OpenAICodexAuthStore(this.config.dataDir);
    this.fetchImpl = deps?.fetchImpl || fetch;
    this.transport = deps?.transport || new SseCodexTransport(this.fetchImpl);
  }

  override buildRequest(messages: Message[], config: ProviderConfig): any {
    this.validateCodexConfig(config);
    return buildCodexRequest(messages, config);
  }

  override buildRequestWithTools(messages: Message[], config: ProviderConfig, toolRequest: ProviderToolRequest): any {
    this.validateCodexConfig(config);
    return buildCodexRequest(messages, config, toolRequest);
  }

  override async getAuthStatus(): Promise<ProviderAuthStatus> {
    const profile = await this.authStore.getActiveProfile();
    return {
      provider: this.name,
      authenticated: Boolean(profile),
      activeProfileId: profile?.id,
      accountLabel: profile?.email ?? profile?.accountId ?? profile?.displayName,
      expiresAt: profile?.expiresAt,
      modelsAvailable: profile ? OPENAI_CODEX_MODELS.map(item => item.ref) : [],
    };
  }

  override async beginLogin(options?: Record<string, unknown>): Promise<ProviderAuthChallenge> {
    const disableLocalCallback = options?.disableLocalCallback === true;
    const login = await beginLoginSession({
      authStore: this.authStore,
      authorizeUrl: this.config.authorizeUrl,
      tokenUrl: this.config.tokenUrl,
      clientId: this.config.clientId,
      redirectUri: this.config.redirectUri,
      originator: this.config.originator,
      allowedWorkspaceId:
        typeof options?.allowedWorkspaceId === 'string' ? options.allowedWorkspaceId : this.config.allowedWorkspaceId,
    });

    if (!disableLocalCallback) {
      const port = extractPort(this.config.redirectUri);
      try {
        const waiter = await startOAuthCallbackServer(port);
        this.callbackSessions.set(login.session.id, { waiter });
      } catch {
        // Manual fallback stays available.
      }
    }

    return login.challenge;
  }

  override async completeLogin(payload: ProviderAuthCompletion): Promise<ProviderAuthStatus> {
    try {
      return await completeLoginSession({
        authStore: this.authStore,
        payload,
        fetchImpl: this.fetchImpl,
        probeProfile: async (profile) => {
          await this.probeProfile(profile);
        },
      });
    } finally {
      await this.disposeCallbackSession(payload.loginId);
    }
  }

  override async logout(profileId?: string): Promise<void> {
    const active = await this.authStore.getActiveProfile();
    const target = profileId || active?.id;
    if (target) {
      await this.authStore.removeProfile(target);
    }
  }

  override async complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse> {
    this.validateCodexConfig(config);
    const profile = await this.ensureAuthenticated(resolveOpenAICodexModel(config.model).ref);
    const body = buildCodexRequest(messages, { ...config, stream: true });
    return this.collectStreamedResponse(this.transport.stream({
      endpoint: this.config.endpoint,
      headers: this.createHeaders(profile),
      body,
    }));
  }

  override async completeWithTools(
    messages: Message[],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): Promise<ProviderToolResponse> {
    this.validateCodexConfig(config);
    const profile = await this.ensureAuthenticated(resolveOpenAICodexModel(config.model).ref);
    const body = buildCodexRequest(messages, { ...config, stream: true }, toolRequest);
    return this.collectStreamedResponse(this.transport.stream({
      endpoint: this.config.endpoint,
      headers: this.createHeaders(profile),
      body,
    }));
  }

  override async *streamEvents(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent> {
    this.validateCodexConfig(config);
    const profile = await this.ensureAuthenticated(resolveOpenAICodexModel(config.model).ref);
    const body = buildCodexRequest(messages, { ...config, stream: true });
    yield* this.transport.stream({
      endpoint: this.config.endpoint,
      headers: this.createHeaders(profile),
      body,
    });
  }

  override async *streamEventsWithTools(
    messages: Message[],
    config: ProviderConfig,
    toolRequest: ProviderToolRequest
  ): AsyncIterable<ProviderStreamEvent> {
    this.validateCodexConfig(config);
    const profile = await this.ensureAuthenticated(resolveOpenAICodexModel(config.model).ref);
    const body = buildCodexRequest(messages, { ...config, stream: true }, toolRequest);
    yield* this.transport.stream({
      endpoint: this.config.endpoint,
      headers: this.createHeaders(profile),
      body,
    });
  }

  private validateCodexConfig(config: ProviderConfig): void {
    this.validateConfig(config);
    resolveOpenAICodexModel(config.model);
  }

  private async ensureAuthenticated(targetModel: string): Promise<OAuthProfile> {
    try {
      const current = await getValidProfile({
        authStore: this.authStore,
        tokenUrl: this.config.tokenUrl,
        clientId: this.config.clientId,
        fetchImpl: this.fetchImpl,
      });
      if (current) return current;
    } catch (error) {
      if (!(error instanceof TokenRefreshFailedError)) {
        throw error;
      }
    }

    const afterLogin = await this.performInteractiveLogin(targetModel);
    if (!afterLogin) {
      throw new SubscriptionAuthRequiredError();
    }
    return afterLogin;
  }

  private async performInteractiveLogin(targetModel: string): Promise<OAuthProfile | undefined> {
    const isTelegram = isTelegramAuthContext();
    const challenge = await this.beginLogin({ disableLocalCallback: isTelegram });

    if (isTelegram) {
      await notifyTelegramAboutLogin(challenge);
      const redirectUrl = await askTelegramForRedirectUrl(challenge);
      await this.completeLogin({ loginId: challenge.loginId, redirectUrl });
      return this.authStore.getActiveProfile();
    }

    this.printConsoleLoginStart(challenge, targetModel);
    await openAuthUrlInBrowser(challenge.authUrl).catch(() => {});

    const callback = this.callbackSessions.get(challenge.loginId);
    if (callback) {
      try {
        const result = await callback.waiter.waitForResult;
        await this.completeLogin({
          loginId: challenge.loginId,
          callbackCode: result.code,
          callbackState: result.state,
        });
        return this.authStore.getActiveProfile();
      } catch (error) {
        if (!(error instanceof OAuthCallbackTimeoutError)) {
          throw error;
        }
      }
    }

    const redirectUrl = await promptConsoleForRedirectUrl(challenge);
    await this.completeLogin({ loginId: challenge.loginId, redirectUrl });
    return this.authStore.getActiveProfile();
  }

  private printConsoleLoginStart(challenge: ProviderAuthChallenge, targetModel: string): void {
    const chatId = actionContext.getStore()?.chatId;
    if (chatId) return;

    console.log(`[openai-codex] Authentication required for ${targetModel}.`);
    console.log(`[openai-codex] Open this URL in your browser:\n${challenge.authUrl}`);
    console.log(`[openai-codex] ${challenge.manualMessage}`);
  }

  private createHeaders(profile: OAuthProfile): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${profile.accessToken}`,
      'content-type': 'application/json',
    };

    if (profile.accountId) {
      headers['ChatGPT-Account-Id'] = profile.accountId;
    }

    return headers;
  }

  private async probeProfile(profile: OAuthProfile): Promise<void> {
    const probeBody = buildCodexRequest(
      [
        { role: 'system', content: 'Reply tersely.' },
        { role: 'user', content: 'Reply with OK only.' },
      ],
      {
        model: OPENAI_CODEX_DEFAULT_MODEL,
        maxTokens: 16,
        reasoning: 'off',
        stream: true,
      }
    );

    await this.collectStreamedResponse(this.transport.stream({
      endpoint: this.config.endpoint,
      headers: this.createHeaders(profile),
      body: probeBody,
    })).catch((error) => {
      throw new CodexTransportFailedError(`Probe failed after ChatGPT login: ${String((error as Error)?.message ?? error)}`, { cause: error });
    });
  }

  private async collectStreamedResponse(events: AsyncIterable<ProviderStreamEvent>): Promise<ProviderToolResponse> {
    let content = '';
    let reasoning = '';
    const toolCalls: ProviderToolResponse['toolCalls'] = [];
    let finishReason: ProviderToolResponse['finishReason'] = 'other';

    for await (const event of events) {
      if (event.type === 'text.delta') {
        content += event.delta ?? '';
      } else if (event.type === 'reasoning.delta') {
        reasoning += event.delta ?? '';
      } else if (event.type === 'tool_call.done' && event.toolCall) {
        toolCalls.push(event.toolCall);
      } else if (event.type === 'done') {
        finishReason = 'stop';
      }
    }

    return {
      content,
      reasoning,
      finishReason,
      toolCalls,
    };
  }

  private async disposeCallbackSession(loginId: string): Promise<void> {
    const entry = this.callbackSessions.get(loginId);
    this.callbackSessions.delete(loginId);
    if (entry) {
      await entry.waiter.close().catch(() => {});
    }
  }
}

function extractPort(redirectUri: string): number {
  try {
    return Number(new URL(redirectUri).port) || 1455;
  } catch {
    return 1455;
  }
}

registerProvider('openai-codex', () => new OpenAICodexProvider());

export default OpenAICodexProvider;
