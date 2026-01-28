/**
 * Search Tool
 *
 * Provides web search, answer, content retrieval, and research capabilities
 * using the Exa API.
 */

import Exa from 'exa-js';
import {
    GOOGLE_IMG_SCRAP
} from 'google-img-scrap';

// Initialize Exa client
const exa = new Exa(process.env.EXA_API_KEY);

// ============================================================================
// Types
// ============================================================================

export type SearchType = 'auto' | 'keyword' | 'neural';

export type Category =
  | 'company'
  | 'research paper'
  | 'news'
  | 'pdf'
  | 'github'
  | 'tweet'
  | 'personal site'
  | 'people'
  | 'financial report';

export type ContentMode = 'none' | 'snippet' | 'summary' | 'full';

export interface SearchOptions {
  numResults?: number;
  type?: SearchType;
  category?: Category;
  content?: ContentMode;
}

export interface ContentOptions {
  content?: ContentMode;
}

export interface ResearchOptions {
  stream?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  id: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  highlights?: string[];
  summary?: string;
  text?: string;
}

export interface AnswerResult {
  answer: string;
  citations: Array<{
    title: string;
    url: string;
    id: string;
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

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Build contents options based on content mode
 */
function buildContentsOptions(mode: ContentMode = 'none'): Record<string, boolean> | false {
  switch (mode) {
    case 'snippet':
      return { highlights: true };
    case 'summary':
      return { summary: true };
    case 'full':
      return { text: true };
    case 'none':
    default:
      return false;
  }
}

// ============================================================================
// Exported Functions
// ============================================================================

/**
 * Get a quick answer to a question using Exa's Answer API
 *
 * @param query - The question to answer
 * @returns Answer with citations
 */
export async function answer(query: string): Promise<AnswerResult> {
  console.log(`[Search] Getting answer for: "${query}"`);

  try {
    const response = await exa.answer(query);

    return {
      answer: typeof response.answer === 'string' ? response.answer : JSON.stringify(response.answer),
      citations: response.citations.map((c) => ({
        title: c.title || 'Untitled',
        url: c.url,
        id: c.id,
      })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Exa answer failed: ${message}`);
  }
}

/**
 * Perform a web search using Exa's Search API
 *
 * @param query - The search query
 * @param options - Search configuration options
 * @returns Array of search results
 */
export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const {
    numResults = 5,
    type = 'fast',
    category,
    content = 'summary',
  } = options;

  console.log(`[Search] Searching for: "${query}" (type: ${type}, results: ${numResults})`);
  if (category) {
    console.log(`[Search] Category: ${category}`);
  }

  try {
    const searchParams: any = {
      numResults,
      type,
      contents: buildContentsOptions(content),
    };

    if (category) {
      searchParams.category = category;
    }

    const response = await exa.search(query, searchParams);

    console.log(response)

    return response.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Exa search failed: ${message}`);
  }
}

/**
 * Get content from specific URLs using Exa's getContents API
 *
 * @param urls - URL or array of URLs to fetch content from
 * @param options - Content retrieval options
 * @returns Array of content results
 */
export async function getContent(
  urls: string | string[],
  options: ContentOptions = {}
): Promise<SearchResult[]> {
  const { content = 'full' } = options;
  const urlArray = Array.isArray(urls) ? urls : [urls];

  console.log(`[Search] Fetching content from ${urlArray.length} URL(s)`);
  urlArray.forEach(url => console.log(`  - ${url}`));

  try {
    const contentsOpts = buildContentsOptions(content);
    const response = await exa.getContents(
      urlArray,
      contentsOpts === false ? undefined : contentsOpts
    );

    return response.results.map((r: any) => ({
      title: r.title || 'Untitled',
      url: r.url,
      id: r.id,
      publishedDate: r.publishedDate,
      author: r.author,
      highlights: r.highlights,
      summary: r.summary,
      text: r.text,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Exa getContents failed: ${message}`);
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

    // Deduplicate results by ID
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
  console.log(`[Search] Using model: exa-research-fast`);

  try {
    // Create the research request
    const createResponse = await exa.research.create({
      instructions: topic,
      model: 'exa-research-fast',
    });

    const researchId = createResponse.researchId;
    console.log(`[Search] Research ID: ${researchId}`);

    if (stream) {
      // Stream mode - poll and display progress
      console.log(`[Search] Streaming research progress...`);
      console.log('---');

      // Get streaming updates
      const streamGen = await exa.research.get(researchId, { stream: true, events: true });

      for await (const event of streamGen) {
        // Log different event types
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

    // Poll until finished and get final result
    const result = await exa.research.pollUntilFinished(researchId, {
      pollInterval: 2000,
      timeoutMs: 300000, // 5 minutes
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
    } else if (result.status === 'failed') {
      const failedResult = result as any;
      throw new Error(`Research failed: ${failedResult.error || 'Unknown error'}`);
    } else {
      return {
        output: '',
        status: result.status as 'canceled',
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Exa research failed: ${message}`);
  }
}
