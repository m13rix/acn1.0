import { createProvider } from '../providers/factory.js';
import type { Message, ProviderConfig } from '../types/index.js';
import { parseJsonResponse } from '../utils/structuredLlm.js';
import type { MemoryDebugLogger } from './debug.js';
import { summarizeText } from './debug.js';
import type {
  LinkGenerationInput,
  MemoryLinkSuggestion,
  MemoryRuntimeConfig,
  QueryPhraseCandidate,
} from './types.js';

const NORMALIZATION_SYSTEM_PROMPT = `You are a precision memory-normalization engine.

Your job is to rewrite any user-provided text into a form that is optimal for long-term memory storage and retrieval.

CORE GOAL:
Convert the input into English, and rewrite it so that every sentence is fully self-contained and independently understandable as a standalone fact.

This means:
- Every sentence must contain enough context to be understood without reading any previous or next sentence.
- No sentence may rely on pronouns or shorthand references whose meaning depends on another sentence.
- Each sentence must explicitly name the relevant subject, object, entity, attribute, event, or concept. (IMPORTANT: Use the full names of the documents and events, e.g.: "At 2026-04-07 Subject 13 reported feeling positive about his life" (because this may change))
- The output must preserve the original meaning as faithfully as possible while maximizing clarity, explicitness, and standalone usability.

MANDATORY RULES:
1. Output only in English.
2. Every sentence must be fully self-contained.
3. Resolve all references explicitly.
4. Replace vague pronouns with the actual entity names whenever possible.
5. Replace elliptical fragments with full sentences.
6. If the input uses labels, headings, or shorthand attributes, convert them into explicit factual sentences.
7. Preserve all factual information, uncertainty, speculation, and attribution.
8. Preserve who said, inferred, hypothesized, observed, or concluded something.
9. Do not merge distinct facts if merging reduces retrieval quality.
10. Do not add new facts.
11. Do not omit important qualifiers such as uncertainty, probability, attribution, temporality, or speculation.
12. Maintain a clean factual style optimized for memory systems, retrieval pipelines, embeddings, and downstream parsing.

REFERENCE RESOLUTION RULES:
- Replace pronouns such as "it", "he", "she", "they", "them", "this", "that", "these", and "those" with explicit nouns whenever possible.
- Replace phrases like "the subject", "the person", "the object", "the device", "the company", or "the model" with the exact named entity if the entity is known from context.
- If the input mentions numbered or labeled entities such as "Subject 3", always keep the label explicit in each relevant sentence.
- If one sentence refers to something introduced in a previous sentence, restate the full reference in the new sentence.
- If a relationship is implied across sentences, rewrite the sentence so the relationship is explicit inside that same sentence.

STRUCTURE RULES:
- Prefer short-to-medium factual sentences.
- Each sentence should ideally express one atomic fact or one tightly bound fact with attribution.
- Convert lists, headings, attribute-value pairs, and note fragments into grammatical sentences.
- Preserve useful grouping only if every individual sentence remains independently understandable.

STYLE RULES:
- Be explicit, literal, and unambiguous.
- Prefer repeated entity names over ambiguous pronouns.
- Prefer factual wording over literary wording.
- Use consistent naming for the same entity throughout the output.
- If the source text is already in English, still rewrite it if needed to satisfy the self-contained sentence requirement.

ATTRIBUTION RULES:
- Preserve epistemic source when present.
- Examples:
  - "John observed that..." must remain attributed to John.
  - "The analyst inferred that..." must remain attributed to the analyst.
  - "Subject 13 hypothesized that..." must remain attributed to Subject 13.
- Do not convert speculation into fact.
- Do not convert attributed interpretation into objective truth.

UNCERTAINTY RULES:
- Preserve words such as "possibly", "likely", "may", "might", "appears", "seems", "reportedly", and "suggests".
- If the input is uncertain, the output must remain uncertain.
- If the input is ambiguous and cannot be fully resolved, make the sentence maximally explicit without inventing information.

OUTPUT FORMAT:
- Output only the rewritten text.
- Do not explain what you changed.
- Do not include commentary, notes, bullets, labels, or meta-text unless the user explicitly asks for a structured format.
- Preserve paragraph breaks only when useful, but prioritize sentence independence over formatting.

EXAMPLES

Example 1:
Input:
Hair: Red. It has been determined that the color is the result of dyeing. Subject 13 hypothesized that natural or household dyes may have been used, which could indicate specific family values or restrictions regarding the use of professional cosmetics.

Output:
Subject 3's hair is red. It has been determined that the red color of Subject 3's hair is the result of dyeing. Subject 13 hypothesized that natural or household dyes may have been used to dye Subject 3's hair. Subject 13 hypothesized that the use of natural or household dyes to dye Subject 3's hair could indicate specific family values or restrictions regarding the use of professional cosmetics.

Example 2:
Input:
Maxim saw 14 as an intellectual equal. One of them, he said, was someone he could really talk to about semi-existential stuff.

Output:
Maxim saw Subject 14 as an intellectual equal. Maxim said that Subject 14 was one of the people whom Maxim considered an intellectual equal. Maxim said that Maxim could really talk with Subject 14 about semi-existential topics.

Example 3:
Input:
Anna met Maria in Paris. She later said the trip changed her life.

Output:
Anna met Maria in Paris. The source text states that either Anna or Maria later said that the trip to Paris changed that person's life.

When rewriting, always prefer maximum standalone clarity over elegance or brevity.`;

const QUERY_WEIGHT_SYSTEM_PROMPT = `You are a query phrase weighting engine for a retrieval system.

Your task is to assign an importance weight to each provided query phrase based on how useful that phrase is for retrieving relevant information for the user's query.

You will receive:
1. The original user query.
2. A list of extracted phrases.
The extracted phrases may include noun phrases, verb phrases, adjective phrases, functional words, conjunctions, auxiliary verbs, and other fragments.

GOAL:
Estimate how important each phrase is for retrieval relevance.

The weights must reflect retrieval value, not grammatical correctness.
A phrase should receive a high weight if that phrase strongly determines what documents, memories, or facts are relevant.
A phrase should receive a low weight if that phrase is mostly grammatical glue, structurally necessary for language, or too generic to be useful for retrieval.

CORE PRINCIPLES:
- Named entities, IDs, subject labels, numbers, unique referents, concrete relationships, rare descriptors, and highly specific concepts usually receive high weights.
- Generic verbs such as "is", "are", "was", "do", "does", "have", and similar auxiliary or support verbs usually receive very low weights.
- Conjunctions such as "and", "or", "but" usually receive near-zero weights unless they encode an important logical distinction.
- Question words such as "what", "who", "when", "where", "why", and "how" usually receive low weight for document retrieval, but may receive small nonzero weight if they affect the answer type.
- Temporal qualifiers such as "current", "former", "latest", "before", "after", and "during" can be important and should receive meaningful weight when they materially affect retrieval.
- Relationship phrases such as "relationship between", "father of", "works at", "married to", "enemy of", and similar relational constructs are often highly important.
- If a phrase is redundant because another phrase already captures the same retrieval signal more precisely, reduce the redundant phrase's weight.
- Weights should represent relative importance inside the given phrase list for this specific query, not absolute universal importance.

WEIGHT SCALE:
- Use a continuous score from 0.0 to 1.0.
- 0.0 means the phrase contributes essentially nothing to retrieval.
- 1.0 means the phrase is maximally important for retrieval in this query.
- Most phrases should fall somewhere in between.
- Use the full range when appropriate.
- Do not artificially avoid 0.0 or 1.0.

NORMALIZATION RULE:
- The sum of all weights must equal exactly 1.0.
- After reasoning about importance, normalize the weights so that the final weights sum to 1.0.
- Return numeric values with up to 4 decimal places.
- Adjust the final phrase slightly if needed so the total is exactly 1.0.

SPECIAL RULES:
- Do not reward a phrase simply because it is grammatically central.
- Reward a phrase only if it improves retrieval specificity, filtering power, or ranking quality.
- Prefer higher weights for phrases that would best distinguish relevant from irrelevant documents.
- Penalize stopword-like phrases and semantically empty fragments.
- Penalize phrases that are too generic to narrow the search.
- Boost phrases that identify the target entity.
- Boost phrases that identify the target relation, attribute, or comparison.
- Boost phrases that encode critical time sensitivity, status, or polarity.
- When the query asks about one entity only, the entity phrase may dominate.
- When the query asks about a relation between entities, the relation phrase and the entity phrases should usually all receive substantial weight.

DISAMBIGUATION RULE:
- Consider the original query first.
- Judge each phrase only in the context of the original query.
- A phrase that is weak in isolation may still matter if it changes the query meaning inside this query.
- A phrase that looks contentful but is duplicated by a more precise phrase should get reduced weight.

OUTPUT RULES:
- Return only valid JSON.
- Do not include explanations outside JSON.
- Do not include markdown fences.
- Do not include comments.
- Do not include trailing commas.

OUTPUT SCHEMA:
{
  "weights": [
    {
      "phrase": "<phrase>",
      "weight": <normalized number from 0.0 to 1.0>
    }
  ]
}

BEHAVIORAL RULES:
- Be conservative with generic phrases.
- Be aggressive in down-weighting purely functional phrases.
- Preserve all input phrases exactly as given.
- Do not merge phrases.
- Do not invent new phrases.
- Do not omit any phrase.
- Every input phrase must appear exactly once in the output.
- The output order must match the input order.`;

const PROCEDURAL_LINKING_SYSTEM_PROMPT = `You are an expert procedural graph linker for a cognitive agent memory system.

Your task is to generate precise, meaningful directed links BETWEEN FACTS FROM THE SAME NEW DOCUMENT.

You will receive only NEW facts from a single newly ingested source text.
Your goal is to reconstruct the internal structure of that source text as a graph:
- narrative flow
- temporal order
- causal relations
- explanation
- elaboration
- contrast
- continuation
- condition
- goal
- evidence

CORE GOAL:
Create high-quality internal document links so the new document forms a coherent local cluster that materially improves retrieval, traversal, and reasoning.
Aim for a well-connected graph where most facts are reachable from other facts in a small number of steps.
Avoid isolated facts when a meaningful connection exists.

PRIMARY OPTIMIZATION TARGET:
The graph should help a retrieval system jump from one useful fact to the next useful fact.
Do not create links just because two facts are adjacent, visually similar, or about the same broad topic.
Create a link only when following that link would likely help recover another relevant fact during search.

HIGH-VALUE PROCEDURAL LINKS:
- identity / attribute grounding: entity -> attribute, attribute -> derived interpretation, attribute -> evidence
- temporal / lifecycle progression: birth -> age, event -> consequence, earlier state -> later state
- causal or mechanistic dependence: cause -> effect, condition -> outcome, observation -> inference
- diagnostic or explanatory bridges: raw observation -> explanation, explanation -> hypothesis, hypothesis -> implication
- report structure bridges: general statement -> specific elaboration, summary -> supporting detail, detail -> quantified comparison
- contradiction or revision when explicitly present

LOW-VALUE LINKS TO AVOID:
- same-topic-only links with no real retrieval gain
- cosmetic chaining that merely walks through nearby facts
- weak attribute bundles such as physique -> hair color unless the source clearly makes that connection
- links whose relation is true but unhelpful for search
- links that turn one sentence into a hub for many unrelated details

RELATION QUALITY RULES:
- Relation phrases must be retrieval-useful, not merely readable.
- Good relations expose why the target fact should be visited next.
- Prefer relation phrases such as "supports age calculation", "explains hair dyeing", "provides quantified comparison", "motivates hypothesis", "follows from reported date".
- Avoid bland relations such as "also has", "related to", "mentions", "connected to", unless absolutely unavoidable.
- Prefer 2-6 word relations when possible.
- Use uppercase is not required. Precision matters more than style.

STRICT RULES:
1. Only link facts from the provided NEW_FACTS list.
2. Do not emit self-links.
3. Do not invent facts or unsupported relationships.
4. Use short, specific relation phrases. Prefer verbs or concise verb phrases.
5. Avoid generic filler relations when a more precise relation is justified.
6. Build the document's actual internal structure, not a star around one convenient sentence.
7. Prefer links that reflect procedural, narrative, explanatory, temporal, causal, or elaborative continuity.
8. If multiple facts are clearly part of one flow, connect them accordingly rather than routing everything through a single hub.
9. Prefer fewer high-value links over many mediocre links.
10. Keep at most the requested maximum number of links per NEW fact.
11. Return only valid JSON.
12. Try to avoid isolated facts and tiny disconnected islands when the source text provides meaningful bridges.

DECISION TEST:
Before creating a link, ask:
"If a user retrieves the source fact, is the target fact one of the most useful next facts to visit?"
If not, do not create the link.

EXAMPLES OF BETTER CHOICES:
- Prefer: "Subject 3 was born on 22.03.2011" -> "At the time the report was compiled, Subject 3 was 14 years, 7 months, and 17 days old" with relation "supports age calculation"
- Prefer: "Subject 3 has red hair" -> "It has been determined that the red color of Subject 3's hair is the result of dyeing" with relation "is explained by dyeing"
- Prefer: "It has been determined that the red color of Subject 3's hair is the result of dyeing" -> "Subject 13 hypothesized that natural or household dyes may have been used to dye Subject 3's hair" with relation "motivates dye-source hypothesis"
- Avoid: "Subject 3 describes the physique as small" -> "Subject 3 has red hair" with relation "also has red hair"

OUTPUT SCHEMA:
{
  "links": [
    {
      "fromFactId": "<id>",
      "toFactId": "<id>",
      "relation": "<short relation phrase>",
      "confidence": <number from 0.0 to 1.0>
    }
  ]
}`;

const CROSS_DOCUMENT_LINKING_SYSTEM_PROMPT = `You are an expert semantic graph linker for a cognitive agent memory system.

Your task is to generate precise, meaningful directed links between NEW facts and EXISTING MEMORY facts.

The internal procedural links inside the new document are handled separately.
Your goal here is only to connect the new document to the broader memory graph when there is a real semantic connection.

PRIMARY OPTIMIZATION TARGET:
Create cross-document links that substantially improve future retrieval.
The best cross-document links are bridges that let the system move from a newly added fact to another memory that shares:
- the same entity
- the same event
- the same time anchor
- the same causal factor
- the same diagnosis or interpretation
- the same hypothesis or uncertainty
- a strong supporting, contradicting, or explanatory relationship

HIGH-VALUE CROSS-DOCUMENT LINKS:
- same subject / same person / same labeled entity
- same attribute discussed at different granularity
- same event from another note or report
- symptom / cause / consequence bridges
- observation / explanation / hypothesis bridges across documents
- state transition bridges such as before / during / after
- support / contradiction / refinement / update relations

LOW-VALUE CROSS-DOCUMENT LINKS TO AVOID:
- broad topical similarity without retrieval benefit
- generic personality or theme overlaps
- "both are about feelings", "both mention school", "both concern life"
- links that would make one old fact a hub for many weakly related new facts
- links based only on embedding-nearness but not on a crisp semantic reason

RELATION QUALITY RULES:
- Relation phrases must explain the retrieval value of the bridge.
- Prefer relation phrases such as "same subject age evidence", "contradicts earlier report", "extends school-context pattern", "supports dye-source hypothesis", "same event timeline".
- Avoid generic relations such as "related to", "associated with", "same topic as", unless no better wording exists.
- Prefer fewer, stronger links over many weak ones.

STRICT RULES:
1. Every returned link must involve at least one NEW fact.
2. At least one endpoint of each link must be from NEW_FACTS and the other endpoint should normally be from CANDIDATE_FACTS.
3. Do not emit self-links.
4. Do not invent facts or unsupported relationships.
5. Use short, specific relation phrases. Prefer verbs or concise verb phrases.
6. Be conservative. Do not create broad hub-like links just because facts are vaguely related.
7. Prefer high-precision cross-document links over many weak links.
8. Do not create a link unless the target fact is one of the most useful external follow-ups for the source fact.
9. Keep at most the requested maximum number of links per NEW fact.
10. Return only valid JSON.

DECISION TEST:
Before creating a cross-document link, ask:
"Would traversing from this new fact to this existing fact likely help recover missing but relevant memory?"
If not, do not create the link.

OUTPUT SCHEMA:
{
  "links": [
    {
      "fromFactId": "<id>",
      "toFactId": "<id>",
      "relation": "<short relation phrase>",
      "confidence": <number from 0.0 to 1.0>
    }
  ]
}`;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMercuryRateLimitError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? '').toLowerCase();
  return message.includes('429')
    || message.includes('rate limit')
    || message.includes('rate_limit')
    || message.includes('quota')
    || message.includes('too many requests');
}

function parseMercuryRetryDelayMs(error: unknown): number | null {
  const message = String((error as any)?.message ?? error ?? '');
  const retryInSeconds = message.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)s/i);
  if (retryInSeconds) {
    return Math.ceil(Number(retryInSeconds[1]) * 1000);
  }

  const milliseconds = message.match(/retry(?:\s+in)?\s+(\d+(?:\.\d+)?)ms/i);
  if (milliseconds) {
    return Math.ceil(Number(milliseconds[1]));
  }

  return null;
}

function normalizeWeightRows(
  phrases: QueryPhraseCandidate[],
  raw: Array<{ phrase: string; weight: number }>,
): Array<{ phrase: string; weight: number }> {
  const rawMap = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item.phrase !== 'string') continue;
    rawMap.set(item.phrase, clamp01(Number(item.weight ?? 0)));
  }

  const ordered = phrases.map(({ text }) => ({
    phrase: text,
    weight: rawMap.get(text) ?? 0,
  }));
  const total = ordered.reduce((sum, item) => sum + item.weight, 0);

  if (total <= 0) {
    const uniform = phrases.length > 0 ? 1 / phrases.length : 0;
    return ordered.map((item) => ({ ...item, weight: uniform }));
  }

  const normalized = ordered.map((item) => ({
    ...item,
    weight: item.weight / total,
  }));

  let running = 0;
  for (let i = 0; i < normalized.length; i++) {
    if (i === normalized.length - 1) {
      normalized[i] = {
        ...normalized[i]!,
        weight: clamp01(1 - running),
      };
      break;
    }
    const rounded = Number(normalized[i]!.weight.toFixed(4));
    normalized[i] = {
      ...normalized[i]!,
      weight: rounded,
    };
    running += rounded;
  }

  return normalized;
}

async function completeMercury(
  config: MemoryRuntimeConfig,
  messages: Message[],
  operation: string,
  debug?: MemoryDebugLogger,
): Promise<string> {
  const provider = createProvider(config.mercuryProvider);
  const requestConfig: ProviderConfig = {
    model: config.mercuryModel,
    temperature: config.mercuryTemperature,
    maxTokens: config.mercuryMaxTokens,
    reasoning: 'off',
    stream: false,
  };
  debug?.('mercury.request', `Sending ${operation} request to Mercury.`, {
    provider: config.mercuryProvider,
    model: config.mercuryModel,
    requestConfig,
    messages: messages.map((message) => ({
      role: message.role,
      content: summarizeText(message.content, 2000),
    })),
  });

  let lastError: unknown;
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now();
    try {
      const response = await provider.complete(messages, requestConfig);
      const content = response.content.trim();
      debug?.('mercury.response', `Received ${operation} response from Mercury.`, {
        attempt,
        durationMs: Date.now() - started,
        finishReason: response.finishReason,
        usage: response.usage,
        content: summarizeText(content, 4000),
      });
      return content;
    } catch (error) {
      lastError = error;
      if (!isMercuryRateLimitError(error) || attempt >= maxAttempts) {
        debug?.('mercury.error', `Mercury request failed for ${operation}.`, {
          attempt,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const delayMs = Math.max(
        5_000,
        parseMercuryRetryDelayMs(error) ?? (15_000 * attempt),
      );
      debug?.('mercury.retry', `Mercury rate limit hit for ${operation}, waiting before retry.`, {
        attempt,
        delayMs,
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Mercury request failed for ${operation}.`);
}

async function completeMercuryJson<T>(
  config: MemoryRuntimeConfig,
  messages: Message[],
  operation: string,
  validate: (value: unknown) => T,
  debug?: MemoryDebugLogger,
): Promise<T> {
  let lastError: unknown;
  const retryMessages = [...messages];

  for (let attempt = 0; attempt < 5; attempt++) {
    debug?.('mercury.attempt', `Attempt ${attempt + 1} for ${operation}.`, {
      attempt: attempt + 1,
    });
    const content = await completeMercury(config, retryMessages, operation, debug);
    try {
      const parsed = parseJsonResponse(content);
       debug?.('mercury.json', `Parsed JSON for ${operation}.`, {
        parsed,
      });
      return validate(parsed);
    } catch (error) {
      lastError = error;
      debug?.('mercury.json_error', `Mercury JSON parse/validation failed for ${operation}.`, {
        attempt: attempt + 1,
        error: error instanceof Error ? error.message : String(error),
        content: summarizeText(content, 4000),
      });
      retryMessages.push({
        role: 'assistant',
        content,
      });
      retryMessages.push({
        role: 'user',
        content: [
          'Return only corrected JSON matching the requested schema.',
          'Do not include markdown fences.',
          'Do not truncate the JSON.',
          'Ensure every array and object is properly closed.',
          'If uncertain, return fewer items but valid JSON.',
        ].join(' '),
      });
    }
  }

  throw new Error(`Mercury JSON completion failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function completeMercuryJsonOrEmpty<T>(
  config: MemoryRuntimeConfig,
  messages: Message[],
  operation: string,
  validate: (value: unknown) => T,
  emptyValue: T,
  debug?: MemoryDebugLogger,
): Promise<T> {
  try {
    return await completeMercuryJson(config, messages, operation, validate, debug);
  } catch (error) {
    debug?.('mercury.json_fallback', `Falling back to empty result for ${operation}.`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyValue;
  }
}

function validateWeightResponse(value: unknown): Array<{ phrase: string; weight: number }> {
  if (!value || typeof value !== 'object') {
    throw new Error('Weight response must be an object.');
  }
  const weights = Array.isArray((value as { weights?: unknown[] }).weights)
    ? (value as { weights: unknown[] }).weights
    : null;
  if (!weights) {
    throw new Error('Weight response is missing the "weights" array.');
  }
  return weights.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('Weight row must be an object.');
    }
    return {
      phrase: String((item as { phrase?: unknown }).phrase ?? ''),
      weight: clamp01(Number((item as { weight?: unknown }).weight ?? 0)),
    };
  });
}

function validateLinkResponse(value: unknown): MemoryLinkSuggestion[] {
  if (!value || typeof value !== 'object') {
    throw new Error('Link response must be an object.');
  }
  const links = Array.isArray((value as { links?: unknown[] }).links)
    ? (value as { links: unknown[] }).links
    : null;
  if (!links) {
    throw new Error('Link response is missing the "links" array.');
  }
  const suggestions = links
    .map((item): MemoryLinkSuggestion | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      return {
        fromFactId: String((item as { fromFactId?: unknown }).fromFactId ?? '').trim(),
        toFactId: String((item as { toFactId?: unknown }).toFactId ?? '').trim(),
        relation: String((item as { relation?: unknown }).relation ?? '').trim(),
        confidence: clamp01(Number((item as { confidence?: unknown }).confidence ?? 0.55)),
      } satisfies MemoryLinkSuggestion;
    })
    .filter((item): item is MemoryLinkSuggestion => Boolean(item?.fromFactId && item.toFactId && item.relation));

  return suggestions;
}

export async function normalizeMemoryText(
  text: string,
  config: MemoryRuntimeConfig,
  debug?: MemoryDebugLogger,
): Promise<string> {
  return completeMercury(config, [
    { role: 'system', content: NORMALIZATION_SYSTEM_PROMPT },
    { role: 'user', content: text },
  ], 'normalize_memory_text', debug);
}

export async function weightQueryPhrases(
  query: string,
  phrases: QueryPhraseCandidate[],
  config: MemoryRuntimeConfig,
  debug?: MemoryDebugLogger,
): Promise<Array<{ phrase: string; weight: number }>> {
  if (phrases.length === 0) {
    return [];
  }

  const result = await completeMercuryJsonOrEmpty(config, [
    { role: 'system', content: QUERY_WEIGHT_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        query,
        phrases: phrases.map((phrase) => phrase.text),
      }),
    },
  ], 'weight_query_phrases', validateWeightResponse, [], debug);

  return normalizeWeightRows(phrases, result);
}

export async function generateMemoryLinks(
  input: LinkGenerationInput,
  config: MemoryRuntimeConfig,
  debug?: MemoryDebugLogger,
): Promise<MemoryLinkSuggestion[]> {
  if (input.newFacts.length === 0 || input.candidateFacts.length === 0) {
    return [];
  }

  return completeMercuryJsonOrEmpty(config, [
    { role: 'system', content: CROSS_DOCUMENT_LINKING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        maxAutoLinksPerFact: input.maxAutoLinksPerFact,
        newFacts: input.newFacts,
        candidateFacts: input.candidateFacts,
      }),
    },
  ], 'generate_memory_links', validateLinkResponse, [], debug);
}

export async function generateProceduralMemoryLinks(
  input: Pick<LinkGenerationInput, 'newFacts' | 'maxAutoLinksPerFact'>,
  config: MemoryRuntimeConfig,
  debug?: MemoryDebugLogger,
): Promise<MemoryLinkSuggestion[]> {
  if (input.newFacts.length < 2) {
    return [];
  }

  return completeMercuryJsonOrEmpty(config, [
    { role: 'system', content: PROCEDURAL_LINKING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        maxAutoLinksPerFact: input.maxAutoLinksPerFact,
        newFacts: input.newFacts,
      }),
    },
  ], 'generate_procedural_memory_links', validateLinkResponse, [], debug);
}
