export class OpenAICodexError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    if (options && 'cause' in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class OAuthCallbackTimeoutError extends OpenAICodexError {
  constructor(message = 'Timed out waiting for OAuth callback.') {
    super('OAuthCallbackTimeout', message);
  }
}

export class OAuthStateMismatchError extends OpenAICodexError {
  constructor(message = 'OAuth state mismatch.') {
    super('OAuthStateMismatch', message);
  }
}

export class TokenExchangeFailedError extends OpenAICodexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TokenExchangeFailed', message, options);
  }
}

export class TokenRefreshFailedError extends OpenAICodexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('TokenRefreshFailed', message, options);
  }
}

export class SubscriptionAuthRequiredError extends OpenAICodexError {
  constructor(message = 'ChatGPT subscription authentication is required for openai-codex.') {
    super('SubscriptionAuthRequired', message);
  }
}

export class OAuthOnlyModelSelectedViaApiProviderError extends OpenAICodexError {
  constructor(message = 'This model requires the openai-codex provider and ChatGPT authentication.') {
    super('OAuthOnlyModelSelectedViaApiProvider', message);
  }
}

export class CodexTransportFailedError extends OpenAICodexError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('CodexTransportFailed', message, options);
  }
}

export class CodexUnauthorizedError extends OpenAICodexError {
  constructor(message = 'openai-codex request was unauthorized.') {
    super('CodexUnauthorized', message);
  }
}

export class CodexRateLimitedError extends OpenAICodexError {
  constructor(message = 'openai-codex request was rate limited.') {
    super('CodexRateLimited', message);
  }
}
