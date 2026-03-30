/**
 * Search Tool
 *
 * Provides Tavily-backed search, answer, and crawl capabilities,
 * plus Exa-backed long-form research and Google Image Search.
 */

import { tavily } from '@tavily/core';
import { Exa } from 'exa-js';
import {
  GOOGLE_IMG_SCRAP
} from 'google-img-scrap';

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });
const exa = new Exa(process.env.EXA_API_KEY);
const MAX_RESULT_CONTENT_CHARS = 4000;
const MAX_RESULT_RAW_CONTENT_CHARS = 12000;
const MAX_CRAWL_RAW_CONTENT_CHARS = 12000;

// ============================================================================
// Types
// ============================================================================

export type SearchDepth = 'basic' | 'advanced' | 'fast' | 'ultra-fast';
export type SearchTopic = 'general' | 'news' | 'finance';
export type SearchOutputMode = 'urls' | 'full';
export type AnswerOutputMode = 'answer' | 'answerAndUrls' | 'answerAndSources';

export interface SearchOptions {
  maxResults?: number;
  topic?: SearchTopic;
  searchDepth?: SearchDepth;
  output?: SearchOutputMode;
}

export interface AnswerOptions {
  topic?: SearchTopic;
  searchDepth?: SearchDepth;
  maxResults?: number;
  output?: AnswerOutputMode;
}

export interface ResearchOptions {
  stream?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  content?: string;
  rawContent?: string;
  score?: number;
  publishedDate?: string;
  favicon?: string;
}

export interface AnswerResult {
  answer: string;
  sources?: string[] | SearchResult[];
}

export interface CrawlResult {
  baseUrl: string;
  results: Array<{
    url: string;
    rawContent: string;
    favicon?: string;
  }>;
}

export interface ResearchResult {
  output: string;
  status: 'completed' | 'failed' | 'canceled';
  costDollars?: {
    total: number;
    numSearches: number;
    numPages: number;
  };
}

export interface ImageSearchResult {
  id: string;
  title: string;
  url: string;
  originalUrl: string;
  height: number;
  width: number;
}

export interface ImageSearchOptions {
  limit?: number;
}

function truncateText(value: string | undefined, maxChars: number, label: string): string | undefined {
  if (!value || value.length <= maxChars) {
    return value;
  }

  const reserved = Math.min(220, Math.max(100, Math.floor(maxChars * 0.18)));
  const headLength = Math.max(0, Math.floor((maxChars - reserved) * 0.75));
  const tailLength = Math.max(0, maxChars - reserved - headLength);
  const removed = value.length - headLength - tailLength;
  const notice = `\n\n[${label} truncated: removed ${removed} chars]\n\n`;
  return `${value.slice(0, headLength)}${notice}${value.slice(value.length - tailLength)}`;
}

function mapTavilyResult(result: {
  title: string;
  url: string;
  content: string;
  rawContent?: string;
  score: number;
  publishedDate: string;
  favicon?: string;
}): SearchResult {
  return {
    title: result.title || 'Untitled',
    url: result.url,
    content: truncateText(result.content, MAX_RESULT_CONTENT_CHARS, 'content'),
    rawContent: truncateText(result.rawContent, MAX_RESULT_RAW_CONTENT_CHARS, 'rawContent'),
    score: result.score,
    publishedDate: result.publishedDate,
    favicon: result.favicon,
  };
}

/**
 * Main way to search: asks Tavily for an answer and source grounding.
 *
 * @param query - The question to answer
 * @param options - Output and Tavily search options
 * @returns Answer only, answer with source URLs, or answer with full sources
 */
export async function answer(
  query: string,
  options: AnswerOptions = {}
): Promise<AnswerResult> {
  const {
    topic = 'general',
    searchDepth = 'advanced',
    maxResults = 5,
    output = 'answerAndUrls',
  } = options;

  console.log(`[Search] Getting Tavily answer for: "${query}"`);

  try {
    const response = await tavilyClient.search(query, {
      topic,
      searchDepth,
      maxResults,
      includeAnswer: 'advanced',
      includeFavicon: true,
      includeRawContent: output === 'answerAndSources' ? 'markdown' : false,
    });

    const answerText = typeof response.answer === 'string' ? response.answer : '';
    const sources = response.results.map(mapTavilyResult);

    if (output === 'answer') {
      return { answer: answerText };
    }

    if (output === 'answerAndSources') {
      return {
        answer: answerText,
        sources,
      };
    }

    return {
      answer: answerText,
      sources: sources.map((source) => source.url),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Tavily answer failed: ${message}`);
  }
}

/**
 * Perform a normal web search with Tavily.
 *
 * @param query - The search query
 * @param options - Search configuration options
 * @returns URLs only by default; `full` returns the normal Tavily result objects
 */
export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<string[] | SearchResult[]> {
  const {
    maxResults = 5,
    topic = 'general',
    searchDepth = 'advanced',
    output = 'urls',
  } = options;

  console.log(`[Search] Tavily search for: "${query}" (results: ${maxResults})`);

  try {
    const response = await tavilyClient.search(query, {
      topic,
      searchDepth,
      maxResults,
      includeFavicon: true,
    includeRawContent: false,
    });

    const results = response.results.map(mapTavilyResult);
    return output === 'full' ? results : results.map((result) => result.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Tavily search failed: ${message}`);
  }
}

/**
 * Crawl a page and its subpages to answer a focused prompt.
 *
 * @param url - Starting URL to crawl
 * @param prompt - Instructions for what to find across the crawled content
 * @returns Crawled raw content grouped by source page
 */
export async function crawl(url: string, prompt: string): Promise<CrawlResult> {
  console.log(`[Search] Tavily crawl starting at: ${url}`);
  console.log(`[Search] Crawl prompt: "${prompt}"`);

  try {
    const response = await tavilyClient.crawl(url, {
      instructions: prompt,
      extractDepth: 'advanced',
    });

    return {
      baseUrl: response.baseUrl,
      results: response.results.map((result) => ({
        url: result.url,
        rawContent: truncateText(result.rawContent, MAX_CRAWL_RAW_CONTENT_CHARS, 'rawContent') || '',
        favicon: result.favicon,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Tavily crawl failed: ${message}`);
  }
}

/**
 * Search for images using Google Image Search
 *
 * @param query - The search query for images
 * @param options - Image search options (limit)
 * @returns Array of image search results (deduplicated)
 */
export async function imageSearch(
  query: string,
  options: ImageSearchOptions = {}
): Promise<ImageSearchResult[]> {
  const { limit = 5 } = options;

  console.log(`[Search] Searching for images: "${query}" (limit: ${limit})`);

  try {
    const response = await GOOGLE_IMG_SCRAP({
      search: query
    });

    if (!response || !response.result || !Array.isArray(response.result)) {
      throw new Error('Invalid response from Google Image Search');
    }

    const seenIds = new Set<string>();
    const deduplicatedResults: ImageSearchResult[] = [];

    for (const item of response.result) {
      if (item.id && !seenIds.has(item.id) && deduplicatedResults.length < limit) {
        seenIds.add(item.id);
        deduplicatedResults.push({
          id: item.id,
          title: item.title || 'Untitled',
          url: item.url || '',
          originalUrl: item.originalUrl || item.url || '',
          height: item.height || 0,
          width: item.width || 0,
        });
      }
    }

    console.log(`[Search] Found ${deduplicatedResults.length} unique images`);
    return deduplicatedResults;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Google Image Search failed: ${message}`);
  }
}

/**
 * Perform deep research on a topic using Exa's Research API
 *
 * @param topic - The research topic or question (used as instructions)
 * @param options - Research options (streaming)
 * @returns Research report with output and status
 */
export async function research(
  topic: string,
  options: ResearchOptions = {}
): Promise<ResearchResult> {
  const { stream = true } = options;

  console.log(`[Search] Researching: "${topic}"`);
  console.log('[Search] Using model: exa-research-fast');

  try {
    const createResponse = await exa.research.create({
      instructions: topic,
      model: 'exa-research-fast',
    });

    const researchId = createResponse.researchId;
    console.log(`[Search] Research ID: ${researchId}`);

    if (stream) {
      console.log('[Search] Streaming research progress...');
      console.log('---');

      const streamGen = await exa.research.get(researchId, { stream: true, events: true });

      for await (const event of streamGen) {
        if (event.eventType === 'task-operation') {
          const taskOp = event as any;
          if (taskOp.data?.type === 'think') {
            console.log(`[Think] ${taskOp.data.content.slice(0, 100)}...`);
          } else if (taskOp.data?.type === 'search') {
            console.log(`[Search] Query: "${taskOp.data.query}"`);
          } else if (taskOp.data?.type === 'crawl') {
            console.log(`[Crawl] ${taskOp.data.result?.url}`);
          }
        } else if (event.eventType === 'research-output') {
          const outputEvent = event as any;
          if (outputEvent.output?.outputType === 'completed') {
            console.log('---');
            console.log(outputEvent.output.content);
          }
        }
      }
    }

    const result = await exa.research.pollUntilFinished(researchId, {
      pollInterval: 2000,
      timeoutMs: 300000,
      events: false,
    });

    console.log(`[Search] Research complete. Status: ${result.status}`);

    if (result.status === 'completed') {
      const completedResult = result as any;
      return {
        output: completedResult.output?.content || '',
        status: 'completed',
        costDollars: completedResult.costDollars ? {
          total: completedResult.costDollars.total,
          numSearches: completedResult.costDollars.numSearches,
          numPages: completedResult.costDollars.numPages,
        } : undefined,
      };
    }

    if (result.status === 'failed') {
      const failedResult = result as any;
      throw new Error(`Research failed: ${failedResult.error || 'Unknown error'}`);
    }

    return {
      output: '',
      status: result.status as 'canceled',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Exa research failed: ${message}`);
  }
}
