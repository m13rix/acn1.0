import 'dotenv/config';
import { execFile } from 'child_process';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'fs/promises';
import { basename, dirname, extname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { extractPdfPageRange, extractPdfTextByPageRange, readPdfPageCount } from './pdf.js';
import type {
  CreateHomeworkDocumentInput,
  HomeworkDocumentMetadata,
  HomeworkDocumentSection,
  HomeworkDocumentSummary,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const LIBRARY_ROOT = join(PROJECT_ROOT, 'data', 'homework-library');
const DOCUMENTS_DIR = join(LIBRARY_ROOT, 'documents');
const SOURCE_PDF_NAME = 'source.pdf';
const METADATA_NAME = 'metadata.json';
const CACHE_DIR_NAME = 'cache';
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
const OCR_SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'homework_pdf_ocr.py');
const SECTION_CACHE_VERSION = 3;
const RETRYABLE_GEMINI_STATUSES = new Set([429, 500, 502, 503, 504]);
const GEMINI_MAX_RETRIES = 4;

function getApiKey(): string {
  const apiKey = process.env['GEMINI_KEY'] || process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new Error('GEMINI_KEY or GEMINI_API_KEY is required.');
  }
  return apiKey;
}

function getClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: getApiKey() });
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'document';
}

function normalizeTitle(title: string, originalFilename: string): string {
  const trimmed = title.trim();
  if (trimmed) return trimmed;
  const name = basename(originalFilename, extname(originalFilename)).replace(/[_-]+/g, ' ').trim();
  return name || 'Untitled document';
}

function metadataPath(documentId: string): string {
  return join(DOCUMENTS_DIR, documentId, METADATA_NAME);
}

function sourcePdfPath(documentId: string): string {
  return join(DOCUMENTS_DIR, documentId, SOURCE_PDF_NAME);
}

function cacheFilePath(documentId: string, sectionNumber: number): string {
  return join(DOCUMENTS_DIR, documentId, CACHE_DIR_NAME, `section-${sectionNumber}.txt`);
}

function logicalPageToPdfPage(logicalPage: number, pageOffset: number, pageCount: number): number {
  const pdfPage = logicalPage - pageOffset;
  return Math.max(1, Math.min(pageCount, Math.floor(pdfPage)));
}

function cleanPlainText(text: string): string {
  const strippedFence = text
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '');
  return strippedFence.replace(/\r\n/g, '\n').trim();
}

function describeDocumentUnit(sectionType: string): string {
  const trimmed = String(sectionType || '').trim();
  return trimmed || 'document unit';
}

function buildUnitScopeInstructions(sectionType: string, fullName: string): string[] {
  const unitLabel = describeDocumentUnit(sectionType);
  return [
    `The requested document unit type is "${unitLabel}". The requested ${unitLabel} is titled: ${fullName}.`,
    `Extract the full content that belongs to this ${unitLabel}, not just its opening fragment.`,
    `If this ${unitLabel} contains nested headings, subsections, examples, or internal subparts that still belong to the same ${unitLabel}, keep them.`,
    `Stop only when the next sibling ${unitLabel} begins or when clearly unrelated appendix or exercise material starts.`,
  ];
}

function normalizeForSearch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    // OCR often mixes Latin/Cyrillic Roman-numeral glyphs and digit 1 in headings.
    .replace(/[хx]/g, 'x')
    .replace(/[іi1l|!]/g, 'i')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findNormalizedIndex(source: string, query: string): number {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return -1;

  let normalizedSource = '';
  const sourceIndexes: number[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    const normalizedChar = char.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
    if (!normalizedChar) continue;

    for (const part of normalizedChar) {
      if (part === ' ' && normalizedSource.endsWith(' ')) continue;
      normalizedSource += part;
      sourceIndexes.push(index);
    }
  }

  const position = normalizedSource.indexOf(normalizedQuery);
  if (position < 0) return -1;
  return sourceIndexes[position] ?? -1;
}

function trimSectionExtras(rawText: string, targetSection: HomeworkDocumentSection, nextSection?: HomeworkDocumentSection): string {
  let text = rawText.replace(/\r\n/g, '\n').replace(/\u00ad/g, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';

  const headingPosition = findNormalizedIndex(text, targetSection.fullName);
  const foundTargetHeading = headingPosition >= 0;
  if (headingPosition > 0) {
    text = text.slice(headingPosition).trim();
  }

  if (nextSection) {
    const nextHeadingPosition = findNormalizedIndex(text, nextSection.fullName);
    if (nextHeadingPosition > 0) {
      text = text.slice(0, nextHeadingPosition).trim();
    }
  }

  const stopMarkers = [
    'Вопросы и задания',
    'В классе и дома',
    'Подумаем',
    'Вспомним',
    'Документ',
    'Мнения',
    'Подведем итоги',
    'Проверим себя',
    'Практикум',
    'Работаем с источником',
    'Вопросы для обсуждения',
    'Итоги главы',
    'Основные понятия',
  ];

  // If OCR could not align the section heading, avoid trimming on generic
  // markers like "Документ" that may belong to the previous section prelude.
  if (foundTargetHeading) {
    let earliestStop = -1;
    for (const marker of stopMarkers) {
      const markerPosition = findNormalizedIndex(text, marker);
      if (markerPosition > 0 && (earliestStop === -1 || markerPosition < earliestStop)) {
        earliestStop = markerPosition;
      }
    }

    if (earliestStop > 0) {
      text = text.slice(0, earliestStop).trim();
    }
  }

  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return text.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybeStatus = (error as { status?: unknown }).status;
  return typeof maybeStatus === 'number' ? maybeStatus : undefined;
}

function isRetryableGeminiError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status !== undefined && RETRYABLE_GEMINI_STATUSES.has(status);
}

async function runGeminiWithRetries<T>(operationName: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= GEMINI_MAX_RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableGeminiError(error) || attempt === GEMINI_MAX_RETRIES) {
        break;
      }

      const backoffMs = 1200 * Math.pow(2, attempt - 1);
      const jitterMs = Math.floor(Math.random() * 400);
      console.warn(
        `[homework-library] ${operationName} failed with retryable Gemini status ${getErrorStatus(error)}. ` +
        `Retrying in ${backoffMs + jitterMs}ms (attempt ${attempt + 1}/${GEMINI_MAX_RETRIES}).`
      );
      await sleep(backoffMs + jitterMs);
    }
  }

  const status = getErrorStatus(lastError);
  if (status !== undefined && RETRYABLE_GEMINI_STATUSES.has(status)) {
    throw new Error(
      `Gemini temporarily returned HTTP ${status} during ${operationName}. ` +
      `The request was retried ${GEMINI_MAX_RETRIES} times but still failed. Please try again shortly.`
    );
  }

  throw lastError instanceof Error ? lastError : new Error(`${operationName} failed.`);
}

async function runPythonPdfOcr(pdfPath: string, startPage: number, endPage: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python',
      [OCR_SCRIPT_PATH, pdfPath, String(startPage), String(endPage)],
      {
        cwd: PROJECT_ROOT,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`OCR process failed: ${stderr || error.message}`));
          return;
        }

        try {
          const payload = JSON.parse(stdout || '{}') as {
            ok?: boolean;
            error?: string;
            pages?: Array<{ page: number; text: string }>;
          };
          if (!payload.ok) {
            reject(new Error(payload.error || 'OCR process returned an error.'));
            return;
          }

          const text = Array.isArray(payload.pages)
            ? payload.pages.map((page) => String(page.text || '').trim()).filter(Boolean).join('\n\n')
            : '';
          resolve(text.trim());
        } catch (parseError: unknown) {
          const message = parseError instanceof Error ? parseError.message : String(parseError);
          reject(new Error(`Failed to parse OCR output: ${message}`));
        }
      }
    );
  });
}

function toSummary(metadata: HomeworkDocumentMetadata): HomeworkDocumentSummary {
  return {
    id: metadata.id,
    title: metadata.title,
    originalFilename: metadata.originalFilename,
    sectionType: metadata.sectionType,
    tocPagePdf: metadata.tocPagePdf,
    tocPageLogical: metadata.tocPageLogical,
    pageOffset: metadata.pageOffset,
    pageCount: metadata.pageCount,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    sectionCount: metadata.sections.length,
    cachedSectionCount: Object.keys(metadata.cachedSections).length,
    sections: metadata.sections,
  };
}

function validateTocInput(input: CreateHomeworkDocumentInput, pageCount: number): {
  tocInputMode: 'page' | 'text';
  tocPagePdf: number | null;
  tocPageLogical: number | null;
  tocText: string;
} {
  const tocText = String(input.tocText || '').trim();
  const tocPagePdf =
    typeof input.tocPagePdf === 'number' && Number.isFinite(input.tocPagePdf)
      ? Math.floor(input.tocPagePdf)
      : NaN;

  if (tocText) {
    return {
      tocInputMode: 'text',
      tocPagePdf: null,
      tocPageLogical: null,
      tocText,
    };
  }

  if (!Number.isFinite(tocPagePdf) || tocPagePdf < 1 || tocPagePdf > pageCount) {
    throw new Error(`tocPagePdf must be between 1 and ${pageCount}, or provide tocText.`);
  }

  return {
    tocInputMode: 'page',
    tocPagePdf,
    tocPageLogical: tocPagePdf + input.pageOffset,
    tocText: '',
  };
}

async function ensureLibraryDirs(): Promise<void> {
  await mkdir(DOCUMENTS_DIR, { recursive: true });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readMetadata(documentId: string): Promise<HomeworkDocumentMetadata> {
  const raw = (await readFile(metadataPath(documentId), 'utf8')).replace(/^\uFEFF/, '');
  return JSON.parse(raw) as HomeworkDocumentMetadata;
}

async function writeMetadata(metadata: HomeworkDocumentMetadata): Promise<void> {
  await writeFile(metadataPath(metadata.id), JSON.stringify(metadata, null, 2), 'utf8');
}

async function uniqueDocumentId(seed: string): Promise<string> {
  const base = slugify(seed);
  let candidate = base;
  let counter = 2;

  while (await fileExists(join(DOCUMENTS_DIR, candidate))) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }

  return candidate;
}

async function parseTableOfContentsPage(args: {
  tocPdf: Buffer;
  sectionType: string;
}): Promise<Array<{ pageStart: number; pageEnd: number; sectionNumber: number; fullName: string }>> {
  const ai = getClient();
  const response = await runGeminiWithRetries('table-of-contents parsing', () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                `You are extracting a numbered table of contents for a document split into ${args.sectionType}.`,
                `Read only the attached single-page PDF table of contents.`,
                `Return only numbered ${args.sectionType} entries visible on that page.`,
                `Use the printed page numbers from the contents, not the PDF viewer page index.`,
                `If pageEnd is not explicitly inferable from the page itself, set it equal to pageStart.`,
                `Preserve the full section name exactly enough to identify the section.`,
                `Do not include appendices, tasks, tests, glossaries, indexes, or unnumbered decorations.`,
              ].join('\n'),
            },
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: args.tocPdf.toString('base64'),
              },
            },
          ],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['sections'],
          properties: {
            sections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['pageStart', 'pageEnd', 'sectionNumber', 'fullName'],
                properties: {
                  pageStart: { type: Type.NUMBER },
                  pageEnd: { type: Type.NUMBER },
                  sectionNumber: { type: Type.NUMBER },
                  fullName: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    })
  );

  const payload = JSON.parse(response.text || '{"sections":[]}') as {
    sections?: Array<{ pageStart: number; pageEnd: number; sectionNumber: number; fullName: string }>;
  };
  return Array.isArray(payload.sections) ? payload.sections : [];
}

async function parseTableOfContentsText(args: {
  tocText: string;
  sectionType: string;
}): Promise<Array<{ pageStart: number; pageEnd: number; sectionNumber: number; fullName: string }>> {
  const ai = getClient();
  const response = await runGeminiWithRetries('table-of-contents text parsing', () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                `You are extracting a numbered table of contents for a document split into ${args.sectionType}.`,
                `Read only the pasted table-of-contents text below.`,
                `Return only numbered ${args.sectionType} entries from that text.`,
                `Use the printed page numbers from the text, not any PDF viewer page indexes.`,
                `If pageEnd is not explicitly inferable from the text itself, set it equal to pageStart.`,
                `Preserve the full section name closely enough to identify the section.`,
                `Do not include appendices, tasks, tests, glossaries, indexes, or unnumbered decorations.`,
                '',
                'Table of contents text:',
                args.tocText,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          required: ['sections'],
          properties: {
            sections: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                required: ['pageStart', 'pageEnd', 'sectionNumber', 'fullName'],
                properties: {
                  pageStart: { type: Type.NUMBER },
                  pageEnd: { type: Type.NUMBER },
                  sectionNumber: { type: Type.NUMBER },
                  fullName: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    })
  );

  const payload = JSON.parse(response.text || '{"sections":[]}') as {
    sections?: Array<{ pageStart: number; pageEnd: number; sectionNumber: number; fullName: string }>;
  };
  return Array.isArray(payload.sections) ? payload.sections : [];
}

function normalizeSections(args: {
  rawSections: Array<{ pageStart: number; pageEnd: number; sectionNumber: number; fullName: string }>;
  pageOffset: number;
  pageCount: number;
}): HomeworkDocumentSection[] {
  const logicalMaxPage = Math.max(1, args.pageCount + args.pageOffset);
  const dedupe = new Map<number, { pageStart: number; pageEnd: number; sectionNumber: number; fullName: string }>();

  for (const candidate of args.rawSections) {
    if (!candidate) continue;
    if (!Number.isFinite(candidate.sectionNumber) || !Number.isFinite(candidate.pageStart)) continue;

    const sectionNumber = Math.max(1, Math.floor(candidate.sectionNumber));
    const pageStart = Math.max(1, Math.floor(candidate.pageStart));
    const pageEnd = Number.isFinite(candidate.pageEnd)
      ? Math.max(pageStart, Math.floor(candidate.pageEnd))
      : pageStart;
    const fullName = String(candidate.fullName || '').trim();

    if (!fullName) continue;
    if (!dedupe.has(sectionNumber)) {
      dedupe.set(sectionNumber, { sectionNumber, pageStart, pageEnd, fullName });
    }
  }

  const ordered = [...dedupe.values()].sort((left, right) => {
    if (left.pageStart !== right.pageStart) return left.pageStart - right.pageStart;
    return left.sectionNumber - right.sectionNumber;
  });

  return ordered.map((section, index) => {
    const next = ordered[index + 1];
    const inferredLogicalEnd = next
      ? Math.max(section.pageStart, next.pageStart - 1)
      : Math.max(section.pageStart, logicalMaxPage);
    const logicalStart = Math.min(section.pageStart, logicalMaxPage);
    const logicalEnd = next
      ? Math.max(logicalStart, Math.min(section.pageEnd, inferredLogicalEnd, logicalMaxPage))
      : Math.max(logicalStart, logicalMaxPage);
    const finalLogicalEnd = next ? Math.max(logicalStart, next.pageStart - 1) : logicalEnd;

    const pdfPageStart = logicalPageToPdfPage(logicalStart, args.pageOffset, args.pageCount);
    const pdfPageEnd = Math.max(
      pdfPageStart,
      logicalPageToPdfPage(finalLogicalEnd, args.pageOffset, args.pageCount)
    );

    return {
      sectionNumber: section.sectionNumber,
      fullName: section.fullName,
      pageStart: logicalStart,
      pageEnd: finalLogicalEnd,
      pdfPageStart,
      pdfPageEnd,
    };
  });
}

async function buildDocumentMetadata(input: CreateHomeworkDocumentInput): Promise<HomeworkDocumentMetadata> {
  const pageCount = await readPdfPageCount(input.pdfBuffer);
  const sectionType = input.sectionType.trim().toLowerCase() || 'paragraphs';
  const tocInput = validateTocInput(input, pageCount);
  const title = normalizeTitle(input.title || '', input.originalFilename);
  const documentId = await uniqueDocumentId(title);
  const documentDir = join(DOCUMENTS_DIR, documentId);
  const cacheDir = join(documentDir, CACHE_DIR_NAME);

  await mkdir(cacheDir, { recursive: true });
  await writeFile(sourcePdfPath(documentId), input.pdfBuffer);

  try {
    const rawSections =
      tocInput.tocInputMode === 'text'
        ? await parseTableOfContentsText({
            tocText: tocInput.tocText,
            sectionType,
          })
        : await parseTableOfContentsPage({
            tocPdf: await extractPdfPageRange(input.pdfBuffer, tocInput.tocPagePdf!, tocInput.tocPagePdf!),
            sectionType,
          });
    const sections = normalizeSections({
      rawSections,
      pageOffset: input.pageOffset,
      pageCount,
    });

    if (sections.length === 0) {
      throw new Error('Gemini did not return any numbered sections from the selected contents page.');
    }

    const now = new Date().toISOString();
    return {
      id: documentId,
      title,
      originalFilename: input.originalFilename,
      sectionType,
      tocPagePdf: tocInput.tocPagePdf,
      tocPageLogical: tocInput.tocPageLogical,
      pageOffset: input.pageOffset,
      pageCount,
      createdAt: now,
      updatedAt: now,
      model: GEMINI_MODEL,
      tocInputMode: tocInput.tocInputMode,
      sections,
      cachedSections: {},
    };
  } catch (error) {
    await rm(documentDir, { recursive: true, force: true });
    throw error;
  }
}

async function extractSectionTextWithGemini(args: {
  pdfChunk: Buffer;
  sectionType: string;
  sectionNumber: number;
  fullName: string;
}): Promise<string> {
  const ai = getClient();
  const response = await runGeminiWithRetries(`section ${args.sectionNumber} extraction`, () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                `Extract the complete text of ${args.sectionType} ${args.sectionNumber}: ${args.fullName}.`,
                ...buildUnitScopeInstructions(args.sectionType, args.fullName),
                `Return plain Russian text only.`,
                `Keep the heading and all explanatory text that belongs to the requested document unit.`,
                `Skip exercises, assignments, discussion prompts, recap blocks, sidebars, "Вспомним", "Подумаем", "В классе и дома", "Документ", "Мнения", questions, tests, appendices, and any unrelated additional materials.`,
                `If the PDF chunk contains neighboring units, keep only the requested ${describeDocumentUnit(args.sectionType)}.`,
                `Do not add commentary or summaries.`,
              ].join('\n'),
            },
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: args.pdfChunk.toString('base64'),
              },
            },
          ],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        responseMimeType: 'text/plain',
      },
    })
  );

  return cleanPlainText(response.text || '');
}

async function normalizeOcrTextWithGemini(args: {
  ocrText: string;
  sectionType: string;
  sectionNumber: number;
  fullName: string;
}): Promise<string> {
  const ai = getClient();
  const response = await runGeminiWithRetries(`OCR normalization for section ${args.sectionNumber}`, () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                `You will receive noisy OCR text for ${args.sectionType} ${args.sectionNumber}: ${args.fullName}.`,
                ...buildUnitScopeInstructions(args.sectionType, args.fullName),
                `Restore the Russian text, fix OCR mistakes, merge broken words, and preserve paragraph breaks.`,
                `Return only the normalized text in Russian.`,
                `Do not summarize, do not shorten, do not add commentary, and do not invent missing facts.`,
                `If there are obvious exercise headings or side materials, remove them, but keep all text that still belongs to the requested ${describeDocumentUnit(args.sectionType)}.`,
                '',
                args.ocrText,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        responseMimeType: 'text/plain',
      },
    })
  );

  return cleanPlainText(response.text || '');
}

async function postProcessSectionTextWithGemini(args: {
  rawText: string;
  sectionType: string;
  sectionNumber: number;
  fullName: string;
  nextSectionName?: string;
}): Promise<string> {
  const ai = getClient();
  const response = await runGeminiWithRetries(`post-processing section ${args.sectionNumber}`, () =>
    ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                `You will receive extracted Russian text for ${args.sectionType} ${args.sectionNumber}: ${args.fullName}.`,
                ...buildUnitScopeInstructions(args.sectionType, args.fullName),
                `Your task is to clean the extracted text, not to summarize it.`,
                `Requirements:`,
                `1. Keep the full text of the requested ${describeDocumentUnit(args.sectionType)}, including nested subparts that belong to it.`,
                `2. Remove exercises, questions, tasks, sidebars, captions, page furniture, "Вопросы и задания", "Думаем, сравниваем, размышляем", "Работаем с картой", "Документ", "Мнения", and similar extra materials if they are not part of the main section exposition.`,
                `3. Fix obvious OCR mistakes, broken words, wrong letters, and bad paragraph joins.`,
                `4. Preserve the Russian language and paragraph structure.`,
                `5. Do not add any commentary, headings of your own, summaries, or explanations.`,
                `6. If text from the next sibling ${describeDocumentUnit(args.sectionType)} appears, remove it.`,
                args.nextSectionName
                  ? `7. The next ${describeDocumentUnit(args.sectionType)} begins with: ${args.nextSectionName}. Exclude everything from that next unit onward.`
                  : `7. Do not include content from any later sibling ${describeDocumentUnit(args.sectionType)}.`,
                ``,
                `Return only the cleaned Russian text.`,
                ``,
                args.rawText,
              ].join('\n'),
            },
          ],
        },
      ],
      config: {
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MINIMAL,
        },
        responseMimeType: 'text/plain',
      },
    })
  );

  return cleanPlainText(response.text || '');
}

export function getHomeworkLibraryRoot(): string {
  return LIBRARY_ROOT;
}

export async function listStoredDocuments(): Promise<HomeworkDocumentSummary[]> {
  await ensureLibraryDirs();
  const entries = await readdir(DOCUMENTS_DIR, { withFileTypes: true });
  const documents: HomeworkDocumentSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const filePath = metadataPath(entry.name);
    if (!(await fileExists(filePath))) continue;

    try {
      const metadata = await readMetadata(entry.name);
      documents.push(toSummary(metadata));
    } catch {
      // Ignore malformed documents in the list.
    }
  }

  documents.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return documents;
}

export async function createHomeworkDocument(input: CreateHomeworkDocumentInput): Promise<HomeworkDocumentSummary> {
  await ensureLibraryDirs();
  const metadata = await buildDocumentMetadata(input);
  await writeMetadata(metadata);
  return toSummary(metadata);
}

export async function getHomeworkDocument(documentId: string): Promise<HomeworkDocumentSummary> {
  const metadata = await readMetadata(documentId);
  return toSummary(metadata);
}

export async function getHomeworkDocumentPdfPath(documentId: string): Promise<string> {
  const filePath = sourcePdfPath(documentId);
  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Document PDF not found for "${documentId}".`);
  }
  return filePath;
}

/**
 * Extracts a trimmed PDF containing only the pages of the requested section.
 *
 * @param documentId - The document identifier
 * @param sectionNumber - The section number to extract
 * @returns The PDF buffer and the section's full display name
 */
export async function extractSectionPdf(
  documentId: string,
  sectionNumber: number,
): Promise<{ pdfBuffer: Buffer; sectionName: string }> {
  const metadata = await readMetadata(documentId);
  const target = metadata.sections.find((s) => s.sectionNumber === sectionNumber);
  if (!target) {
    throw new Error(`Section ${sectionNumber} was not found in document "${documentId}".`);
  }

  const sourcePdf = await readFile(sourcePdfPath(documentId));
  const pdfBuffer = await extractPdfPageRange(sourcePdf, target.pdfPageStart, target.pdfPageEnd);
  return { pdfBuffer, sectionName: target.fullName };
}

export async function getStoredSectionText(documentId: string, sectionNumber: number): Promise<string> {
  const metadata = await readMetadata(documentId);
  const targetIndex = metadata.sections.findIndex((section) => section.sectionNumber === sectionNumber);
  const target = targetIndex >= 0 ? metadata.sections[targetIndex] : undefined;
  if (!target) {
    throw new Error(`Section ${sectionNumber} was not found in document "${documentId}".`);
  }
  const nextSection = metadata.sections[targetIndex + 1];

  const existing = metadata.cachedSections[String(sectionNumber)];
  if (existing && existing.version === SECTION_CACHE_VERSION) {
    const cachePath = join(DOCUMENTS_DIR, documentId, existing.cacheFile);
    if (await fileExists(cachePath)) {
      const cachedText = await readFile(cachePath, 'utf8');
      if (cachedText.trim()) {
        return cachedText;
      }
    }
  }

  const sourcePdf = await readFile(sourcePdfPath(documentId));
  const sourcePdfAbsolutePath = sourcePdfPath(documentId);
  const locallyExtracted = trimSectionExtras(
    await extractPdfTextByPageRange(sourcePdf, target.pdfPageStart, target.pdfPageEnd),
    target,
    nextSection
  );
  const ocrExtracted = locallyExtracted.length >= 400
    ? ''
    : trimSectionExtras(
      await runPythonPdfOcr(sourcePdfAbsolutePath, target.pdfPageStart, target.pdfPageEnd),
      target,
      nextSection
    );
  const normalizedOcrExtracted = ocrExtracted.length >= 400
    ? trimSectionExtras(
      await normalizeOcrTextWithGemini({
        ocrText: ocrExtracted,
        sectionType: metadata.sectionType,
        sectionNumber,
        fullName: target.fullName,
      }),
      target,
      nextSection
    )
    : '';

  const extractedText = locallyExtracted.length >= 400
    ? locallyExtracted
    : normalizedOcrExtracted.length >= 400
      ? normalizedOcrExtracted
    : ocrExtracted.length >= 400
      ? ocrExtracted
    : await (async () => {
      const pdfChunk = await extractPdfPageRange(sourcePdf, target.pdfPageStart, target.pdfPageEnd);
      return extractSectionTextWithGemini({
        pdfChunk,
        sectionType: metadata.sectionType,
        sectionNumber,
        fullName: target.fullName,
      });
    })();
  const polishedText = extractedText.trim()
    ? trimSectionExtras(
      await postProcessSectionTextWithGemini({
        rawText: extractedText,
        sectionType: metadata.sectionType,
        sectionNumber,
        fullName: target.fullName,
        nextSectionName: nextSection?.fullName,
      }),
      target,
      nextSection
    ) || extractedText
    : extractedText;

  if (!polishedText.trim()) {
    throw new Error(
      `Could not extract text for section ${sectionNumber} in "${documentId}". ` +
      `Local PDF extraction was empty and Gemini fallback also returned no text.`
    );
  }

  const cacheRelativeFile = join(CACHE_DIR_NAME, `section-${sectionNumber}.txt`);
  await writeFile(cacheFilePath(documentId, sectionNumber), polishedText, 'utf8');

  metadata.cachedSections[String(sectionNumber)] = {
    sectionNumber,
    cacheFile: cacheRelativeFile,
    cachedAt: new Date().toISOString(),
    charCount: polishedText.length,
    version: SECTION_CACHE_VERSION,
    strategy: locallyExtracted.length >= 400
      ? 'pdf-text+gemini-post'
      : normalizedOcrExtracted.length >= 400
        ? 'ocr+gemini-normalize+gemini-post'
        : ocrExtracted.length >= 400
          ? 'ocr+gemini-post'
          : 'gemini-pdf+gemini-post',
  };
  metadata.updatedAt = new Date().toISOString();
  await writeMetadata(metadata);

  return polishedText;
}
