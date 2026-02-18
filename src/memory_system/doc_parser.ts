import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getGlobalDisplay } from '../core/GlobalDisplay.js';
import { createProvider } from '../providers/factory.js';
import type { MemoryRuntimeConfig } from './types.js';
import { parseToonTables } from './toon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEBUG_DIR = join(__dirname, '..', '..', 'data', 'memory', 'debug');

const DOC_PARSE_PROMPT_TEMPLATE = `## Input Data:
DOCUMENT_CONTENT:
[содержимое документа]

You are an expert Knowledge Graph Engineer and Cognitive Profiler.
Your task is to process a detailed document and transform it into a structured Knowledge Graph.

You have two simultaneous goals:
1. **DECOMPOSE**: Break the document into many atomic, SELF-CONTAINED facts.
2. **LINK**: Create meaningful semantic connections between these newly created facts.

## Coverage Requirement (No Loss)
- Preserve **100% of document information** as facts.
- Do **not** summarize away details, examples, qualifiers, entities, dates, numbers, or quoted statements.
- If one sentence contains multiple claims, split into multiple facts instead of compressing.
- Prefer more facts over fewer facts when in doubt.
- Every meaningful statement from the source must appear in at least one output fact.

## PART 1: Fact Extraction Rules (The "Self-Contained" Rule)
You must break the text into granular facts.
**CRITICAL:** Every fact must be fully context-aware. You must prepend the metadata (Document Title, Date, Section, Subsection) to the fact content so it makes sense in isolation.

Format: \`[Doc Title | Date | Section > Subsection] Fact content\`

**Example:**
Input:
*Document: "Ignat Profile", Date: 17.05.2024, Section: "I. Psy-OS Model", Subsection: "Core Axioms"*
"Hypothesis 1: World as stimulation. The main driver is avoiding emptiness. People are tools for emotional spikes."

Output Facts:
0, "[Ignat Profile | 17.05.2024 | I. Psy-OS Model > Core Axioms] (Hypothesis 1) World as stimulation: The main driver is avoiding internal emptiness."
1, "[Ignat Profile | 17.05.2024 | I. Psy-OS Model > Core Axioms] Social interactions and people are perceived not as empathy objects, but as tools for generating emotional spikes."

## PART 2: Relationship Types
Link the extracted facts using these precise verbs:
- **CONTINUES**: Fact B follows the narrative flow of Fact A.
- **ELABORATES**: Fact B adds detail or definition to Fact A.
- **EXPLAINS**: Fact B provides the reason/cause for Fact A.
- **CAUSES**: Fact A leads to Fact B (causality).
- **CONTRASTS_WITH**: Direct contradiction or opposing force.
- **IS_PART_OF**: Structural relationship (Fact B is part of concept in Fact A).
- **[CUSTOM]**: Use specific verbs if needed (e.g., "MOTIVATES", "DEFINES", "RESTRICTS").

## Strict Rules:
1. **Granularity**: Do not lump multiple distinct claims into one fact. Split them.
2. **Context Persistence**: Never output a "naked" fact like "He likes apples." It must be "[Profile Ignat... | Diet] He likes apples."
3. **Dense Linking**: Every fact should ideally be linked to at least one other fact (previous or related).
4. **IDs**: Assign sequential integer IDs to facts starting from 0.

## Output Format:
Return ONLY TOON (Token-Oriented Object Notation). No markdown.
Use exactly two tables: \`facts\` and \`links\`.

Example Output:
facts[2,]{id,content}:
0,"[Doc...] First extracted fact..."
1,"[Doc...] Second extracted fact..."

links[1,]{fromId,toId,relation,confidence}:
0,1,CONTINUES,1.0

Schema:
facts[N,]{id,content}:
<id>,<content string>
...
links[M,]{fromId,toId,relation,confidence}:
<fromId>,<toId>,<relation>,<confidence>

Where N is number of facts, M is number of links.`;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

async function writeDebug(payload: unknown): Promise<string> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const filePath = join(DEBUG_DIR, `doc-parser-${stamp}.json`);
  await mkdir(DEBUG_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function normalizeOutputText(text: string): string {
  return (text ?? '').trim();
}

export interface DocParsedFact {
  id: number;
  content: string;
}

export interface DocParsedLink {
  fromId: number;
  toId: number;
  relation: string;
  confidence: number;
}

export interface DocParseResult {
  facts: DocParsedFact[];
  links: DocParsedLink[];
  rawResponse: string;
}

export async function parseDocumentToGraph(
  documentContent: string,
  config: MemoryRuntimeConfig
): Promise<DocParseResult> {
  const display = getGlobalDisplay();
  const provider = createProvider(config.docParserProvider);
  const prompt = DOC_PARSE_PROMPT_TEMPLATE.replace('[содержимое документа]', documentContent);
  const messages = [
    { role: 'system' as const, content: 'Return only TOON. No markdown.' },
    { role: 'user' as const, content: prompt },
  ];

  let fullContent = '';
  const eventCounts: Record<string, number> = {};

  if (!provider.streamEvents) {
    throw new Error(`Provider ${config.docParserProvider} does not support streaming.`);
  }

  if (display) {
    display.showMemoryStep('Parsing document into facts/links with doc parser LLM...');
  }

  const stream = await provider.streamEvents(messages, {
    model: config.docParserModel,
    temperature: config.docParserTemperature,
    maxTokens: config.docParserMaxTokens,
    reasoning: 'off',
    stream: true,
  });

  for await (const event of stream) {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === 'text.delta' && event.delta) {
      fullContent += event.delta;
      console.log(event.delta)
    }
  }

  if (!normalizeOutputText(fullContent)) {
    const completion = await provider.complete(messages, {
      model: config.docParserModel,
      temperature: config.docParserTemperature,
      maxTokens: config.docParserMaxTokens,
      reasoning: "medium",
    });
    fullContent = completion.content ?? '';
    eventCounts['fallback.complete'] = 1;
  }

  try {
    const tables = parseToonTables(fullContent, ['facts', 'links']);
    const factsTable = tables.facts;
    const linksTable = tables.links;
    if (!factsTable) throw new Error('facts table not found in TOON output.');
    if (!linksTable) throw new Error('links table not found in TOON output.');

    const facts: DocParsedFact[] = factsTable.rows.map((row, idx) => {
      const id = Number(row.id);
      const content = String(row.content ?? '').trim();
      if (!Number.isInteger(id)) {
        throw new Error(`facts[${idx}].id must be an integer.`);
      }
      if (!content) {
        throw new Error(`facts[${idx}].content must be non-empty.`);
      }
      return { id, content };
    });

    const factIds = new Set<number>();
    for (const fact of facts) {
      if (factIds.has(fact.id)) throw new Error(`Duplicate fact id ${fact.id}.`);
      factIds.add(fact.id);
    }
    const sorted = [...factIds].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i] !== i) {
        throw new Error(`Fact IDs must be sequential starting from 0. Missing ${i}.`);
      }
    }

    const links: DocParsedLink[] = linksTable.rows.map((row, idx) => {
      const fromId = Number(row.fromId);
      const toId = Number(row.toId);
      const relation = String(row.relation ?? '').trim();
      const confidence = clamp01(Number(row.confidence ?? 0.7));
      if (!Number.isInteger(fromId)) throw new Error(`links[${idx}].fromId must be integer.`);
      if (!Number.isInteger(toId)) throw new Error(`links[${idx}].toId must be integer.`);
      if (!relation) throw new Error(`links[${idx}].relation must be non-empty.`);
      if (!factIds.has(fromId) || !factIds.has(toId)) {
        throw new Error(`links[${idx}] references unknown fact id.`);
      }
      return { fromId, toId, relation, confidence };
    });

    return { facts, links, rawResponse: fullContent };
  } catch (error) {
    const path = await writeDebug({
      stage: 'doc_parse_error',
      provider: config.docParserProvider,
      model: config.docParserModel,
      prompt,
      rawResponse: fullContent,
      eventCounts,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error(`Failed to parse document TOON output. Debug snapshot: ${path}`);
  }
}
