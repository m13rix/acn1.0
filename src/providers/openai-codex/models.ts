export interface OpenAICodexModelDefinition {
  ref: string;
  displayName: string;
  publicId: string;
  backendId: string;
  aliases?: string[];
  oauthOnly: true;
  auth: 'chatgpt';
}

export const OPENAI_CODEX_DEFAULT_MODEL = 'openai-codex/gpt-5-codex';

export const OPENAI_CODEX_MODELS: OpenAICodexModelDefinition[] = [
  {
    ref: 'gpt-5-codex',
    displayName: 'GPT-5 Codex (ChatGPT subscription)',
    publicId: 'gpt-5-codex',
    backendId: 'gpt-5-codex',
    aliases: ['gpt-5.4'],
    oauthOnly: true,
    auth: 'chatgpt',
  },
  {
    ref: 'gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex (ChatGPT subscription)',
    publicId: 'gpt-5.3-codex',
    backendId: 'gpt-5.3-codex',
    oauthOnly: true,
    auth: 'chatgpt',
  },
  {
    ref: 'gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex (ChatGPT subscription)',
    publicId: 'gpt-5.2-codex',
    backendId: 'gpt-5.2-codex',
    oauthOnly: true,
    auth: 'chatgpt',
  },
  {
    ref: 'gpt-5.1-codex',
    displayName: 'GPT-5.1 Codex (ChatGPT subscription)',
    publicId: 'gpt-5.1-codex',
    backendId: 'gpt-5.1-codex',
    oauthOnly: true,
    auth: 'chatgpt',
  },
  {
    ref: 'gpt-5.1-codex-max',
    displayName: 'GPT-5.1 Codex Max (ChatGPT subscription)',
    publicId: 'gpt-5.1-codex-max',
    backendId: 'gpt-5.1-codex-max',
    oauthOnly: true,
    auth: 'chatgpt',
  },
  {
    ref: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini (ChatGPT subscription)',
    publicId: 'gpt-5.4-mini',
    backendId: 'gpt-5.4-mini',
    oauthOnly: true,
    auth: 'chatgpt',
  },
  {
    ref: 'gpt-5.4',
    displayName: 'GPT-5.4 (ChatGPT subscription)',
    publicId: 'gpt-5.4',
    backendId: 'gpt-5.4',
    oauthOnly: true,
    auth: 'chatgpt',
  },
];

const MODEL_BY_REF = new Map(OPENAI_CODEX_MODELS.map(model => [model.ref, model]));
const MODEL_BY_PUBLIC_ID = new Map(OPENAI_CODEX_MODELS.map(model => [model.publicId, model]));
const MODEL_BY_ALIAS = new Map(
  OPENAI_CODEX_MODELS.flatMap(model => (model.aliases || []).map(alias => [alias, model] as const))
);

export function isOpenAICodexModelRef(model: string): boolean {
  return MODEL_BY_REF.has(model) || model.startsWith('openai-codex/');
}

export function resolveOpenAICodexModel(model: string): OpenAICodexModelDefinition {
  const trimmed = String(model || '').trim();
  const byRef = MODEL_BY_REF.get(trimmed);
  if (byRef) return byRef;

  const stripped = trimmed.startsWith('openai-codex/') ? trimmed.slice('openai-codex/'.length) : trimmed;
  const byPublic = MODEL_BY_PUBLIC_ID.get(stripped);
  if (byPublic) return byPublic;
  const byAlias = MODEL_BY_ALIAS.get(stripped);
  if (byAlias) return byAlias;

  throw new Error(`Unknown openai-codex model "${model}". Allowed models: ${OPENAI_CODEX_MODELS.map(item => item.ref).join(', ')}`);
}
