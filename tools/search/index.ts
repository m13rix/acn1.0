/**
 * Provider-backed web research tool.
 *
 * The public API is deliberately provider-neutral: callers keep the same
 * natural object inputs and evidence workflow while Tavily provides retrieval
 * and Exa provides the optional autonomous-research path.
 */

import { tavily } from '@tavily/core';
import { Exa } from 'exa-js';

const MAX_CONTENT_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

type JsonObject = Record<string, any>;
type SearchSourceName = 'web' | 'images' | 'news';
type SearchCategory = 'github' | 'research' | 'pdf';
type ScrapeMode = 'none' | 'summary' | 'markdown';
type AgentModel = 'spark-1-mini' | 'spark-1-pro';

export interface SearchResult {
  title: string;
  url: string;
  description?: string;
  content?: string;
  rawContent?: string;
  summary?: string;
  score?: number;
  publishedDate?: string;
  favicon?: string;
  category?: string;
  metadata?: JsonObject;
}

export interface ImageSearchResult {
  originalUrl: string;
  title?: string;
  sourceUrl?: string;
  width?: number;
  height?: number;
}

export interface NewsSearchResult extends SearchResult {
  date?: string;
  imageUrl?: string;
}

export interface WebSearchResponse {
  query: string;
  web: SearchResult[];
  images: ImageSearchResult[];
  news: NewsSearchResult[];
  warning?: string;
  id?: string;
  creditsUsed?: number;
}

export interface SearchRequest {
  query?: string;
  objective?: string;
  instructions?: string;
  limit?: number;
  maxResults?: number;
  numResults?: number;
  sources?: Array<SearchSourceName | { type: SearchSourceName }>;
  categories?: SearchCategory[];
  includeDomains?: string[];
  excludeDomains?: string[];
  location?: string;
  country?: string;
  tbs?: string;
  scrape?: ScrapeMode;
  includeContent?: boolean;
  output?: 'urls' | 'full' | 'answer' | 'answerAndUrls' | 'answerAndSources';
  model?: AgentModel;
  maxCredits?: number;
  timeoutMs?: number;
  topic?: string;
  searchDepth?: string;
}

export interface AnswerSource {
  url: string;
  title?: string;
  evidence?: string;
}

export interface AnswerClaim {
  claim: string;
  sourceUrls: string[];
  evidence?: string;
}

export interface AnswerResult {
  answer: string;
  sources?: string[] | SearchResult[];
  claims?: AnswerClaim[];
  contradictions?: string[];
  unresolved?: string[];
  confidence?: 'high' | 'medium' | 'low';
  creditsUsed?: number;
}

export interface ScrapeRequest {
  url: string;
  formats?: Array<string | JsonObject>;
  onlyMainContent?: boolean;
  onlyCleanContent?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
  maxAge?: number;
  headers?: Record<string, string>;
  waitFor?: number;
  mobile?: boolean;
  timeout?: number;
  parsers?: string[];
  actions?: JsonObject[];
  location?: { country?: string; languages?: string[] };
  timeoutMs?: number;
}

export interface ScrapeResult {
  url: string;
  /** Compatibility alias for the extracted Markdown/text body. */
  content?: string;
  /** Compatibility alias for the extracted Markdown/text body. */
  rawContent?: string;
  markdown?: string;
  summary?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  images?: unknown[];
  screenshot?: string;
  json?: unknown;
  metadata?: JsonObject;
  warning?: string;
}

export interface CrawlRequest extends Omit<ScrapeRequest, 'url' | 'timeoutMs'> {
  url: string;
  prompt?: string;
  excludePaths?: string[];
  includePaths?: string[];
  maxDiscoveryDepth?: number;
  sitemap?: 'skip' | 'include' | 'only';
  ignoreQueryParameters?: boolean;
  crawlEntireDomain?: boolean;
  allowExternalLinks?: boolean;
  allowSubdomains?: boolean;
  delay?: number;
  maxConcurrency?: number;
  limit?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface CrawlResult {
  baseUrl: string;
  id?: string;
  status: string;
  completed?: number;
  total?: number;
  creditsUsed?: number;
  results: Array<{ url: string; rawContent: string; summary?: string; metadata?: JsonObject }>;
}

export interface MapRequest {
  url: string;
  search?: string;
  sitemap?: 'skip' | 'include' | 'only';
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  limit?: number;
  timeoutMs?: number;
}

export interface MapResult {
  baseUrl: string;
  links: Array<string | JsonObject>;
  creditsUsed?: number;
}

export interface AgentRequest {
  prompt?: string;
  objective?: string;
  query?: string;
  instructions?: string;
  urls?: string[];
  url?: string;
  schema?: JsonObject;
  maxCredits?: number;
  strictConstrainToURLs?: boolean;
  model?: AgentModel;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface AgentResult {
  id: string;
  status: 'completed' | 'failed';
  data?: unknown;
  model?: AgentModel;
  creditsUsed?: number;
  expiresAt?: string;
}

export interface ResearchResult {
  output: string;
  data?: unknown;
  status: 'completed' | 'failed';
  creditsUsed?: number;
  jobId?: string;
}

function getTavily() {
  const apiKey = String(process.env.TAVILY_API_KEY || '').trim();
  if (!apiKey) throw new Error('Tavily is not configured. Set TAVILY_API_KEY in the environment.');
  return tavily({ apiKey });
}

function getExa() {
  const apiKey = String(process.env.EXA_API_KEY || '').trim();
  if (!apiKey) throw new Error('Exa is not configured. Set EXA_API_KEY in the environment.');
  return new Exa(apiKey);
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback;
}

/** Public search arguments use milliseconds; Tavily's SDK expects 1–120 seconds. */
export function toTavilyTimeoutSeconds(timeoutMs: unknown, fallbackMs = DEFAULT_TIMEOUT_MS): number {
  const milliseconds = clampInteger(timeoutMs, fallbackMs, 1_000, 120_000);
  return Math.ceil(milliseconds / 1_000);
}

function truncate(value: unknown, maxChars = MAX_CONTENT_CHARS): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.78);
  return `${value.slice(0, head)}\n\n[content truncated: ${value.length - maxChars} characters omitted]\n\n${value.slice(-(maxChars - head))}`;
}

function stringFromInput(input: string | JsonObject, fields: string[], method: string): string {
  if (typeof input === 'string' && input.trim()) return input.trim();
  if (input && typeof input === 'object') {
    for (const field of fields) if (typeof input[field] === 'string' && input[field].trim()) return input[field].trim();
  }
  throw new Error(`${method} requires a non-empty ${fields.join(' or ')} string.`);
}

function normalizeSources(sources: SearchRequest['sources']): SearchSourceName[] {
  const values = Array.isArray(sources) && sources.length ? sources : ['web'];
  return [...new Set(values.map((item) => typeof item === 'string' ? item : item?.type)
    .filter((item): item is SearchSourceName => item === 'web' || item === 'images' || item === 'news'))] || ['web'];
}

function normalizeSearchRequest(input: string | SearchRequest, options: SearchRequest = {}): SearchRequest & { query: string; limit: number; sources: SearchSourceName[]; scrape: ScrapeMode } {
  const merged = typeof input === 'string' ? { ...options, query: input } : { ...options, ...input };
  return {
    ...merged,
    query: stringFromInput(merged, ['query', 'objective'], 'search'),
    limit: clampInteger(merged.limit ?? merged.maxResults ?? merged.numResults, 5, 1, 20),
    sources: normalizeSources(merged.sources),
    scrape: merged.scrape || (merged.includeContent ? 'markdown' : merged.output === 'full' ? 'summary' : 'none'),
  };
}

function tavilyDepth(value: string | undefined): 'basic' | 'advanced' | 'fast' | 'ultra-fast' {
  return value === 'advanced' || value === 'fast' || value === 'ultra-fast' ? value : 'basic';
}

function tavilyTopic(value: string | undefined): 'general' | 'news' | 'finance' {
  return value === 'news' || value === 'finance' ? value : 'general';
}

function mapResult(value: any): SearchResult | null {
  const url = String(value?.url || '').trim();
  if (!url) return null;
  const content = truncate(value?.content);
  const rawContent = truncate(value?.rawContent);
  return {
    title: String(value?.title || url), url, description: content, content, rawContent,
    summary: content, score: typeof value?.score === 'number' ? value.score : undefined,
    publishedDate: value?.publishedDate, favicon: value?.favicon,
  };
}

function usage(response: any): number | undefined { return response?.usage?.credits; }

async function tavilySearch(request: SearchRequest & { query: string; limit: number; scrape: ScrapeMode }, topic = tavilyTopic(request.topic), images = false): Promise<any> {
  return getTavily().search(request.query, {
    maxResults: request.limit,
    topic,
    searchDepth: tavilyDepth(request.searchDepth),
    includeDomains: request.includeDomains,
    excludeDomains: request.excludeDomains,
    includeImages: images,
    includeImageDescriptions: false,
    includeRawContent: request.scrape === 'markdown' ? 'markdown' : false,
    includeFavicon: true,
    includeUsage: true,
    country: request.country,
    timeout: toTavilyTimeoutSeconds(request.timeoutMs),
  });
}

/** Provider-neutral web search with optional image and news collections. */
export async function web(input: string | SearchRequest, options: SearchRequest = {}): Promise<WebSearchResponse> {
  const request = normalizeSearchRequest(input, options);
  const wantsWeb = request.sources.includes('web');
  const wantsImages = request.sources.includes('images');
  const wantsNews = request.sources.includes('news');
  const [general, news] = await Promise.all([
    wantsWeb || wantsImages ? tavilySearch(request, tavilyTopic(request.topic), wantsImages) : Promise.resolve(undefined),
    wantsNews ? tavilySearch(request, 'news', false) : Promise.resolve(undefined),
  ]);
  const webResults = (general?.results || []).map(mapResult).filter(Boolean) as SearchResult[];
  const newsResults = (news?.results || []).map((value: any) => {
    const mapped = mapResult(value);
    return mapped ? { ...mapped, date: value.publishedDate } : null;
  }).filter(Boolean) as NewsSearchResult[];
  const seen = new Set<string>();
  const images: ImageSearchResult[] = [];
  for (const image of general?.images || []) {
    const originalUrl = typeof image === 'string' ? image : image?.url;
    if (typeof originalUrl === 'string' && originalUrl && !seen.has(originalUrl)) {
      seen.add(originalUrl); images.push({ originalUrl, title: image?.description });
    }
  }
  return {
    query: request.query, web: wantsWeb ? webResults : [], images: wantsImages ? images : [], news: newsResults,
    id: general?.requestId || news?.requestId,
    creditsUsed: (usage(general) || 0) + (usage(news) || 0) || undefined,
  };
}

/** Compatibility search API. Object inputs and maxResults/numResults aliases are accepted. */
export async function search(input: string | SearchRequest, options: SearchRequest = {}): Promise<string[] | SearchResult[]> {
  const request = normalizeSearchRequest(input, options);
  const response = await web(request);
  return request.output === 'full' || request.includeContent || request.scrape !== 'none' ? response.web : response.web.map((entry) => entry.url);
}

/** Read a known URL through Tavily extraction. */
export async function scrape(input: string | ScrapeRequest, options: Partial<ScrapeRequest> = {}): Promise<ScrapeResult> {
  const request = typeof input === 'string' ? { ...options, url: input } : { ...options, ...input };
  const url = stringFromInput(request, ['url'], 'search.scrape');
  const response = await getTavily().extract([url], {
    format: request.formats?.some((format) => format === 'text') ? 'text' : 'markdown',
    extractDepth: 'advanced', includeImages: true, includeFavicon: true, includeUsage: true,
    timeout: toTavilyTimeoutSeconds(request.timeoutMs ?? request.timeout),
  });
  const result = response.results?.[0];
  if (!result) {
    const detail = response.failedResults?.[0]?.error || 'No extractable content returned.';
    return { url, warning: detail };
  }
  const content = truncate(result.rawContent);
  return {
    url: result.url || url,
    content,
    rawContent: content,
    markdown: content,
    summary: truncate(result.rawContent, 4_000),
    images: result.images,
    metadata: { title: result.title, favicon: result.favicon, creditsUsed: usage(response) },
  };
}

/** Crawl a site. Accepts legacy crawl(url, prompt) and the current object form. */
export async function crawl(input: string | CrawlRequest, promptOrOptions: string | Partial<CrawlRequest> = {}): Promise<CrawlResult> {
  const extra = typeof promptOrOptions === 'string' ? { prompt: promptOrOptions } : promptOrOptions;
  const request = typeof input === 'string' ? { ...extra, url: input } : { ...extra, ...input };
  const url = stringFromInput(request, ['url'], 'search.crawl');
  const response = await getTavily().crawl(url, {
    instructions: request.prompt,
    maxDepth: clampInteger(request.maxDiscoveryDepth, 2, 1, 10),
    limit: clampInteger(request.limit, 20, 1, 100),
    selectPaths: request.includePaths,
    excludePaths: request.excludePaths,
    allowExternal: request.allowExternalLinks,
    extractDepth: 'advanced', format: request.formats?.some((format) => format === 'text') ? 'text' : 'markdown',
    includeFavicon: true, includeUsage: true,
    timeout: toTavilyTimeoutSeconds(request.timeoutMs, DEFAULT_JOB_TIMEOUT_MS),
  });
  return {
    baseUrl: response.baseUrl || url, id: response.requestId, status: 'completed', completed: response.results?.length, total: response.results?.length,
    creditsUsed: usage(response),
    results: (response.results || []).map((entry: any) => ({ url: entry.url, rawContent: truncate(entry.rawContent) || '', metadata: { favicon: entry.favicon, images: entry.images } })),
  };
}

/** Map a site to discover URLs before choosing which pages to read. */
export async function map(input: string | MapRequest, options: Partial<MapRequest> = {}): Promise<MapResult> {
  const request = typeof input === 'string' ? { ...options, url: input } : { ...options, ...input };
  const url = stringFromInput(request, ['url'], 'search.map');
  const response = await getTavily().map(url, {
    instructions: request.search, limit: clampInteger(request.limit, 100, 1, 1_000),
    maxDepth: request.includeSubdomains ? 3 : 2, includeUsage: true,
    timeout: toTavilyTimeoutSeconds(request.timeoutMs),
  });
  return { baseUrl: response.baseUrl || url, links: response.results || [], creditsUsed: usage(response) };
}

function composeResearchInstructions(request: AgentRequest, objective: string): string {
  const urls = [...(request.urls || []), ...(request.url ? [request.url] : [])].map(String).map((item) => item.trim()).filter(Boolean);
  return [objective, request.instructions, request.strictConstrainToURLs && urls.length ? `Only use these URLs as evidence: ${urls.join(', ')}` : undefined]
    .filter(Boolean).join('\n\n');
}

/** Autonomous research using Exa. `schema` is passed to Exa when supplied. */
export async function agent(input: string | AgentRequest, options: AgentRequest = {}): Promise<AgentResult> {
  const request = typeof input === 'string' ? { ...options, prompt: input } : { ...options, ...input };
  const objective = stringFromInput(request, ['prompt', 'objective', 'query'], 'search.agent');
  const exa = getExa();
  const created = await exa.research.create({ instructions: composeResearchInstructions(request, objective), model: request.model === 'spark-1-pro' ? 'exa-research' : 'exa-research-fast', ...(request.schema ? { outputSchema: request.schema } : {}) });
  const timeoutMs = clampInteger(request.timeoutMs, DEFAULT_JOB_TIMEOUT_MS, 5_000, 600_000);
  const pollIntervalMs = clampInteger(request.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, 250, 10_000);
  const started = Date.now();
  for (;;) {
    const result: any = await exa.research.get(created.researchId, { events: false });
    if (result.status === 'completed') return { id: created.researchId, status: 'completed', data: result.output?.parsed ?? result.output?.content, model: request.model, creditsUsed: undefined };
    if (result.status === 'failed' || result.status === 'canceled') throw new Error(`Exa research ${result.status}: ${result.error || 'no error detail returned'}`);
    if (Date.now() - started >= timeoutMs) throw new Error(`Exa research did not complete within ${timeoutMs}ms.`);
    await sleep(pollIntervalMs);
  }
}

export const gather = agent;

/**
 * Low-cost grounded answer. Tavily supplies the synthesis and source list;
 * the returned excerpts remain leads, not proof for consequential claims.
 */
export async function answer(input: string | SearchRequest, options: SearchRequest = {}): Promise<AnswerResult> {
  const request = normalizeSearchRequest(input, options);
  const response = await getTavily().search(request.query, {
    maxResults: request.limit, topic: tavilyTopic(request.topic), searchDepth: tavilyDepth(request.searchDepth),
    includeAnswer: 'advanced', includeRawContent: request.output === 'answerAndSources' ? 'markdown' : false,
    includeDomains: request.includeDomains, excludeDomains: request.excludeDomains, includeFavicon: true, includeUsage: true,
    timeout: toTavilyTimeoutSeconds(request.timeoutMs),
  });
  const sources = (response.results || []).map(mapResult).filter(Boolean) as SearchResult[];
  const answerText = typeof response.answer === 'string' && response.answer.trim() ? response.answer : 'Tavily returned sources but no synthesized answer.';
  return {
    answer: answerText,
    sources: request.output === 'answer' ? undefined : request.output === 'answerAndSources' ? sources : sources.map((source) => source.url),
    claims: [], contradictions: [],
    unresolved: ['The answer is provider synthesis. Inspect the cited source pages and scrape decisive pages before relying on consequential facts.'],
    confidence: sources.length ? 'medium' : 'low', creditsUsed: usage(response),
  };
}

export async function imageSearch(input: string | (SearchRequest & { count?: number }), options: SearchRequest & { count?: number } = {}): Promise<ImageSearchResult[]> {
  const request = typeof input === 'string' ? { ...options, query: input } : { ...options, ...input };
  const limit = clampInteger(request.limit ?? request.maxResults ?? request.numResults ?? request.count, 5, 1, 20);
  return (await web({ ...request, limit, sources: ['images'], scrape: 'none' })).images.slice(0, limit);
}

/** Deep autonomous research compatibility API, backed by Exa. */
export async function research(input: string | AgentRequest, options: AgentRequest & { stream?: boolean } = {}): Promise<ResearchResult> {
  const result = await agent(input, options);
  return { output: typeof result.data === 'string' ? result.data : JSON.stringify(result.data ?? {}, null, 2), data: result.data, status: result.status, creditsUsed: result.creditsUsed, jobId: result.id };
}

/** Kept for compatibility; provider diagnostics are surfaced directly in thrown errors. */
export async function diagnose(input: string | { question: string; rationale?: string; jobId?: string; context?: JsonObject }): Promise<JsonObject> {
  const request = typeof input === 'string' ? { question: input } : input;
  return { provider: 'tavily-exa', question: stringFromInput(request, ['question'], 'search.diagnose'), guidance: 'Read the provider error, lower result limits/search depth, or use a known URL with search.scrape().' };
}

/** Kept for compatibility; use `search.help()` for this provider-neutral contract. */
export async function docs(input: string | { question: string }): Promise<JsonObject> {
  const request = typeof input === 'string' ? { question: input } : input;
  return { provider: 'tavily-exa', question: stringFromInput(request, ['question'], 'search.docs'), guidance: 'Run console.log(search.help()) for the available provider-neutral method signatures.' };
}
