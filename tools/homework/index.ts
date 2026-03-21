import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOMEWORK_NOTEBOOK_ID = 'b14102a9-29f2-4cf9-ad2a-10238008c138';

const VALID_BOOKS = ['algebra', 'geometry', 'social_studies', 'history', 'russian'];
const BOOK_PROMPTS: Record<string, string> = {
  algebra: 'Выведите из учебника по алгебре.',
  geometry: 'Выведите из учебника по геометрии.',
  social_studies: 'Выведите из учебника по обществознанию.',
  history: 'Выведите из учебника по истории.',
  russian: 'Выведите из учебника по русскому языку.',
};

function getApiKey(): string {
  const apiKey = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_KEY is not configured.');
  }
  return apiKey;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNotebookQuestion(question: string): string {
  return question.replace(/\r?\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getHomeworkLibraryModule(): Promise<{
  listStoredDocuments: () => Promise<unknown>;
  getStoredSectionText: (documentId: string, sectionNumber: number) => Promise<string>;
  extractSectionPdf: (documentId: string, sectionNumber: number) => Promise<{ pdfBuffer: Buffer; sectionName: string }>;
}> {
  const projectRoot = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..');
  const modulePath = path.join(projectRoot, 'src', 'homework-library', 'index.ts');
  return import(pathToFileURL(modulePath).href);
}

type CommandResult = {
  stdout: string;
  stderr: string;
};

function summarizeOutput(output: string, limit: number = 800): string {
  if (!output) {
    return '';
  }

  return output.length > limit ? `${output.slice(0, limit)}...` : output;
}

/**
 * Runs a command directly without shell interpolation for better quoting stability.
 */
function runCommand(command: string, args: string[], timeoutMs: number = 300_000): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      },
      (error, stdout, stderr) => {
        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();

        if (error) {
          const errorCode = (error as NodeJS.ErrnoException).code;
          if (errorCode === 'ENOENT') {
            reject(
              new Error(
                `Command not found: ${command}. Ensure NotebookLM CLI is installed and available in PATH.`
              )
            );
            return;
          }

          const details = [summarizeOutput(trimmedStderr), summarizeOutput(trimmedStdout)]
            .filter(Boolean)
            .join('\n');
          reject(
            new Error(
              `Command failed: ${command} ${args.join(' ')}${details ? `\n${details}` : ''}`
            )
          );
          return;
        }

        resolve({ stdout: trimmedStdout, stderr: trimmedStderr });
      }
    );
  });
}

function parseJsonOutput(commandLabel: string, output: string): unknown {
  try {
    return JSON.parse(output);
  } catch (error: any) {
    throw new Error(
      `Failed to parse JSON from ${commandLabel}: ${error.message}. Output: ${summarizeOutput(output)}`
    );
  }
}

function getStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getNestedStringField(record: Record<string, unknown>, key: string): string | undefined {
  const direct = getStringField(record[key]);
  if (direct) {
    return direct;
  }

  const nested = record[key];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const nestedRecord = nested as Record<string, unknown>;
    return getStringField(nestedRecord.id) || getStringField(nestedRecord[`${key}_id`]);
  }

  return undefined;
}

function extractNotebookId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Unexpected create response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  const record = payload as Record<string, unknown>;
  const notebookId =
    getStringField(record.id) ||
    getStringField(record.notebook_id) ||
    getNestedStringField(record, 'notebook');

  if (!notebookId) {
    throw new Error(`Notebook ID missing in create response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  return notebookId;
}

function extractSourceId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Unexpected source response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  const record = payload as Record<string, unknown>;
  const sourceId =
    getStringField(record.source_id) ||
    getStringField(record.id) ||
    getNestedStringField(record, 'source');

  if (!sourceId) {
    throw new Error(`Source ID missing in add response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  return sourceId;
}

function extractTaskId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Unexpected generation response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  const record = payload as Record<string, unknown>;
  const taskId =
    getStringField(record.task_id) ||
    getStringField(record.artifact_id) ||
    getStringField(record.id);

  if (!taskId) {
    throw new Error(`Task ID missing in generation response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  return taskId;
}

type NotebookLmSourceInfo = {
  id: string;
  title?: string;
  status?: string;
  status_id?: number;
};

type NotebookLmArtifactInfo = {
  id: string;
  title?: string;
  status?: string;
  status_id?: number;
};

function extractArrayField(payload: unknown, field: string): Record<string, unknown>[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Unexpected ${field} response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  const value = (payload as Record<string, unknown>)[field];
  if (!Array.isArray(value)) {
    throw new Error(`Missing "${field}" array in response: ${summarizeOutput(JSON.stringify(payload))}`);
  }

  return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
}

async function listNotebookSources(notebookId: string): Promise<NotebookLmSourceInfo[]> {
  const payload = parseJsonOutput(
    'notebooklm source list',
    (await runCommand('notebooklm', ['source', 'list', '-n', notebookId, '--json'])).stdout
  );

  return extractArrayField(payload, 'sources').map((item) => ({
    id: getStringField(item.id) || '',
    title: getStringField(item.title),
    status: getStringField(item.status),
    status_id: typeof item.status_id === 'number' ? item.status_id : undefined,
  }));
}

async function listNotebookArtifacts(notebookId: string): Promise<NotebookLmArtifactInfo[]> {
  const payload = parseJsonOutput(
    'notebooklm artifact list',
    (await runCommand('notebooklm', ['artifact', 'list', '-n', notebookId, '--json'])).stdout
  );

  return extractArrayField(payload, 'artifacts').map((item) => ({
    id: getStringField(item.id) || '',
    title: getStringField(item.title),
    status: getStringField(item.status),
    status_id: typeof item.status_id === 'number' ? item.status_id : undefined,
  }));
}

async function waitForSourceReady(
  notebookId: string,
  sourceId: string,
  timeoutMs: number = 600_000,
  pollIntervalMs: number = 5_000
): Promise<NotebookLmSourceInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'missing';

  while (Date.now() <= deadline) {
    const source = (await listNotebookSources(notebookId)).find((item) => item.id === sourceId);
    if (source) {
      const normalizedStatus = (source.status || '').toLowerCase();
      lastStatus = normalizedStatus || String(source.status_id ?? 'unknown');

      if (normalizedStatus === 'ready') {
        return source;
      }

      if (normalizedStatus === 'error' || normalizedStatus === 'failed') {
        throw new Error(
          `Source ${sourceId} failed to process${source.title ? ` (${source.title})` : ''}.`
        );
      }
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for source ${sourceId}. Last known status: ${lastStatus}`);
}

async function waitForArtifactCompletion(
  notebookId: string,
  artifactId: string,
  timeoutMs: number = 2_700_000,
  pollIntervalMs: number = 15_000
): Promise<NotebookLmArtifactInfo> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'missing';

  while (Date.now() <= deadline) {
    const artifact = (await listNotebookArtifacts(notebookId)).find((item) => item.id === artifactId);
    if (artifact) {
      const normalizedStatus = (artifact.status || '').toLowerCase();
      lastStatus = normalizedStatus || String(artifact.status_id ?? 'unknown');

      if (normalizedStatus === 'completed' || normalizedStatus === 'ready') {
        return artifact;
      }

      if (normalizedStatus === 'error' || normalizedStatus === 'failed') {
        throw new Error(
          `Artifact ${artifactId} failed to generate${artifact.title ? ` (${artifact.title})` : ''}.`
        );
      }
    }

    await delay(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for artifact ${artifactId}. Last known status: ${lastStatus}`);
}

export async function ask(bookId: string, question: string): Promise<string> {
  if (!VALID_BOOKS.includes(bookId)) {
    throw new Error(`Invalid bookId "${bookId}". Allowed values: ${VALID_BOOKS.join(', ')}`);
  }

  const normalizedQuestion = normalizeNotebookQuestion(question);
  if (!normalizedQuestion) {
    throw new Error('question is required.');
  }

  const prefix = BOOK_PROMPTS[bookId] || `[${bookId}]`;
  const fullQuery = normalizeNotebookQuestion(`${normalizedQuestion} ${prefix}`);

  try {
    const payload = parseJsonOutput(
      'notebooklm ask',
      (await runCommand('notebooklm', ['ask', fullQuery, '-n', HOMEWORK_NOTEBOOK_ID, '--json'], 300_000)).stdout
    );

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error(`Unexpected ask response: ${summarizeOutput(JSON.stringify(payload))}`);
    }

    const answer = getStringField((payload as Record<string, unknown>).answer);

    if (!answer) {
      throw new Error(`NotebookLM returned an empty answer: ${summarizeOutput(JSON.stringify(payload))}`);
    }

    return answer;
  } catch (error: any) {
    throw new Error(`NotebookLM request failed: ${error.message}`);
  }
}

export async function generateSVG(taskText: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: getApiKey() });
  const model = 'gemini-3-flash-preview';
  const promptPath = path.join(__dirname, 'prompts', 'generate_svg.md');

  try {
    const systemInstruction = await fs.readFile(promptPath, 'utf8');
    const response = await ai.models.generateContent({
      model,
      contents: taskText,
      config: {
        systemInstruction,
      },
    });

    const text = response.text || '';
    const svgMatch = text.match(/```(?:xml|svg)?\s*([\s\S]*?)```/i);
    return svgMatch?.[1]?.trim() || text.trim();
  } catch (error: any) {
    throw new Error(`SVG generation failed: ${error.message}`);
  }
}

export async function formatHomework(taskContent: string, fileName: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: getApiKey() });
  const model = 'gemini-flash-latest';
  const promptPath = path.join(__dirname, 'prompts', 'format_homework.md');

  try {
    const systemInstruction = await fs.readFile(promptPath, 'utf8');
    const response = await ai.models.generateContent({
      model,
      contents: `Отформатируй этот текст как ученик: ${taskContent}`,
      config: {
        systemInstruction,
      },
    });

    const formattedText = response.text || '';
    const targetPath = path.resolve(process.cwd(), fileName);
    await fs.writeFile(targetPath, formattedText, 'utf8');

    return `Saved formatted homework to ${targetPath}\n\n${formattedText}`;
  } catch (error: any) {
    throw new Error(`Homework formatting failed: ${error.message}`);
  }
}

export async function listDocuments(): Promise<unknown> {
  const homeworkLibrary = await getHomeworkLibraryModule();
  return homeworkLibrary.listStoredDocuments();
}

export async function getSectionText(documentId: string, sectionNumber: number): Promise<string> {
  if (!documentId || !documentId.trim()) {
    throw new Error('documentId is required.');
  }
  if (!Number.isFinite(sectionNumber) || sectionNumber < 1) {
    throw new Error('sectionNumber must be a positive integer.');
  }

  const homeworkLibrary = await getHomeworkLibraryModule();
  return homeworkLibrary.getStoredSectionText(documentId.trim(), Math.floor(sectionNumber));
}

/**
 * Generates an explainer video for a document section via NotebookLM,
 * then downloads it and sends to the user in Telegram.
 *
 * @param documentId - The document identifier from the homework library
 * @param sectionNumber - The section number to generate a video for
 * @returns Status message describing the result
 *
 * @example
 * const result = await homework.generateSectionVideo("istoriya-rossii-8", 17);
 * //=> "✅ Video for section 17 generated and sent to Telegram."
 */
export async function generateSectionVideo(documentId: string, sectionNumber: number): Promise<string> {
  if (!documentId || !documentId.trim()) {
    throw new Error('documentId is required.');
  }
  if (!Number.isFinite(sectionNumber) || sectionNumber < 1) {
    throw new Error('sectionNumber must be a positive integer.');
  }

  const docId = documentId.trim();
  const secNum = Math.floor(sectionNumber);
  const tmpDir = os.tmpdir();

  // 1. Extract trimmed PDF for the section
  console.log(`[homework] Extracting section ${secNum} PDF from "${docId}"...`);
  const homeworkLibrary = await getHomeworkLibraryModule();
  const { pdfBuffer, sectionName } = await homeworkLibrary.extractSectionPdf(docId, secNum);

  const tmpPdfPath = path.join(tmpDir, `section_${docId}_${secNum}_${Date.now()}.pdf`);
  await fs.writeFile(tmpPdfPath, pdfBuffer);
  console.log(`[homework] Section PDF saved: ${tmpPdfPath} (${pdfBuffer.length} bytes)`);

  const tmpVideoPath = path.join(tmpDir, `video_${docId}_${secNum}_${Date.now()}.mp4`);

  try {
    // 2. Create a new NotebookLM notebook
    const notebookTitle = sectionName.replace(/\s+/g, ' ').trim().slice(0, 80) || `Section ${secNum}`;
    console.log(`[homework] Creating NotebookLM notebook: "${notebookTitle}"...`);
    const createResult = parseJsonOutput(
      'notebooklm create',
      (await runCommand('notebooklm', ['create', notebookTitle, '--json'])).stdout
    );
    const notebookId = extractNotebookId(createResult);
    console.log(`[homework] Notebook created: ${notebookId}`);

    // 3. Add the section PDF as a source using an explicit notebook ID.
    console.log(`[homework] Adding PDF source to notebook...`);
    const sourceResult = parseJsonOutput(
      'notebooklm source add',
      (
        await runCommand(
          'notebooklm',
          ['source', 'add', tmpPdfPath, '-n', notebookId, '--type', 'file', '--json'],
          300_000
        )
      ).stdout
    );
    const sourceId = extractSourceId(sourceResult);
    console.log(`[homework] Source added: ${sourceId}. Waiting for processing...`);

    // 4. Wait for source processing (up to 10 minutes).
    // Poll the source list instead of using `source wait` because the CLI can
    // occasionally throw an internal traceback even when the source finishes successfully.
    await waitForSourceReady(notebookId, sourceId, 600_000, 5_000);
    console.log(`[homework] Source processed successfully.`);

    // 5. Generate video (explainer, Russian, auto style)
    console.log(`[homework] Starting video generation (this may take 15-45 minutes)...`);
    const videoPrompt = 'Твоя цель: превратить тему или параграф в **захватывающее видео**, в стиле Veritasium, которое заменит скучное чтение.';
    const generateResult = parseJsonOutput(
      'notebooklm generate video',
      (
        await runCommand(
          'notebooklm',
          [
            'generate',
            'video',
            videoPrompt,
            '-n',
            notebookId,
            '-s',
            sourceId,
            '--language',
            'ru',
            '--format',
            'explainer',
            '--style',
            'auto',
            '--retry',
            '2',
            '--json',
          ],
          60_000
        )
      ).stdout
    );
    const artifactId = extractTaskId(generateResult);
    console.log(`[homework] Video generation started: ${artifactId}. Waiting for completion...`);

    // 6. Wait for video generation (up to 45 minutes).
    await waitForArtifactCompletion(notebookId, artifactId, 2_700_000, 15_000);
    console.log(`[homework] Video generation completed!`);

    // 7. Download the video
    console.log(`[homework] Downloading video...`);
    await runCommand('notebooklm', ['download', 'video', tmpVideoPath, '-a', artifactId, '-n', notebookId, '--force'], 120_000);
    console.log(`[homework] Video downloaded: ${tmpVideoPath}`);

    // 8. Send to Telegram
    console.log(`[homework] Sending video to Telegram...`);
    const projectRoot = process.env.PROJECT_ROOT || path.resolve(__dirname, '..', '..');
    const messagePath = path.join(projectRoot, 'tools', 'message', 'index.ts');
    const messageModule = await import(pathToFileURL(messagePath).href) as {
      sendFiles: (files: string[]) => Promise<void>;
    };
    await messageModule.sendFiles([tmpVideoPath]);
    console.log(`[homework] ✅ Video sent to Telegram!`);

    return `✅ Видео для секции ${secNum} ("${sectionName}") сгенерировано и отправлено в Telegram.`;
  } catch (error: any) {
    throw new Error(
      `Failed to generate section video for "${docId}" section ${secNum}: ${error.message}`
    );
  } finally {
    // Cleanup temporary files
    for (const tmpFile of [tmpPdfPath, tmpVideoPath]) {
      try { await fs.unlink(tmpFile); } catch { /* ignore */ }
    }
  }
}
