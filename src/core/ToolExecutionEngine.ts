/**
 * ToolExecutionEngine
 *
 * Shared execution logic for action/cli/file operations.
 * Used by legacy syntax loops and provider-native tool-calling loops.
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type { ProviderToolCall } from '../types/index.js';
import { actionContext } from './ActionContext.js';
import { agentContext } from './AgentContext.js';
import { ActionAutoFixEngine } from './ActionAutoFixEngine.js';
import {
  COMPLETION_SIGNAL_REGEX,
  isCompletionToolName,
  LEGACY_COMPLETION_FUNCTION,
  PRIMARY_COMPLETION_FUNCTION,
} from './completion.js';
import type { Session } from './Session.js';

export interface ToolExecutionCallbacks {
  onAction?: (code: string) => void;
  onCli?: (command: string) => void;
  onFile?: (filename: string, content: string) => void;
}

export interface ToolExecutionResult {
  observation: string;
  filename?: string;
  finishMessage?: string;
  finishParseError?: string;
}

const CONTENT_ARG_KEYS = ['content', 'text', 'body', 'data', 'value'] as const;
const FILE_ARG_KEYS = ['filename', 'fileName', 'path', 'filepath', 'target', 'file'] as const;
const FINISH_ARG_KEYS = ['message', ...CONTENT_ARG_KEYS] as const;
const SUPPORTED_TOOLS = `action, cli, edit_file, view_file, ${PRIMARY_COMPLETION_FUNCTION}`;

type ToolArguments = Record<string, unknown>;

export class ToolExecutionEngine {
  constructor(
    private readonly session: Session,
    private readonly callbacks: ToolExecutionCallbacks = {}
  ) { }

  async executeAction(code: string): Promise<ToolExecutionResult> {
    this.callbacks.onAction?.(code);

    const env = { ...(actionContext.getStore()?.env || {}) };
    env.AGENT_DEPTH = String(agentContext.getStore()?.depth ?? 0);
    // Pass current agent name so tools can load its config in the child process
    const currentAgent = agentContext.getStore()?.agent;
    if (currentAgent?.config?.name) {
      env.TELOS_AGENT_NAME = currentAgent.config.name;
    }
    if (currentAgent?.directory) {
      env.TELOS_AGENT_DIR = currentAgent.directory;
    }
    if (currentAgent?.config?.instructionAlgorithm?.enabled && currentAgent?.config?.instructionAlgorithm?.configPath) {
      env.TELOS_INSTRUCTION_ALGORITHM_CONFIG = currentAgent.config.instructionAlgorithm.configPath;
    }
    env.TELOS_SESSION_ID = this.session.id;
    const memoryCategories = currentAgent?.config?.memory?.categories;
    if (memoryCategories && memoryCategories.length > 0) {
      env.TELOS_MEMORY_CATEGORIES = JSON.stringify(memoryCategories.map((cat) => cat.name));
      const multipliers: Record<string, number> = {};
      for (const cat of memoryCategories) {
        if (typeof cat.multiplier === 'number') {
          multipliers[cat.name] = cat.multiplier;
        }
      }
      if (Object.keys(multipliers).length > 0) {
        env.TELOS_MEMORY_CATEGORY_MULTIPLIERS = JSON.stringify(multipliers);
      }
    }
    if (typeof currentAgent?.config?.memory?.includeUncategorized === 'boolean') {
      env.TELOS_MEMORY_INCLUDE_UNCATEGORIZED = String(currentAgent.config.memory.includeUncategorized);
    }
    if (typeof currentAgent?.config?.memory?.fallbackCategory === 'string' && currentAgent.config.memory.fallbackCategory.trim()) {
      env.TELOS_MEMORY_FALLBACK_CATEGORY = currentAgent.config.memory.fallbackCategory.trim();
    }
    const surfacedMemoryFactIds = typeof (this.session as any).getSurfacedMemoryFactIds === 'function'
      ? (this.session as any).getSurfacedMemoryFactIds()
      : [];
    env.TELOS_MEMORY_EXCLUDE_FACT_IDS = JSON.stringify(surfacedMemoryFactIds);

    const onStderr = (chunk: string) => process.stderr.write(chunk);
    let result = await this.session.sandbox.execute(code, undefined, env, onStderr);
    let autoFixSummary: string[] = [];

    if (!result.success) {
      const autoFixEngine = new ActionAutoFixEngine(this.session);
      const autoFixOutcome = await autoFixEngine.repairAndRetry({
        originalCode: code,
        initialResult: result,
        env,
        onStderr,
      });
      result = autoFixOutcome.result;
      autoFixSummary = autoFixOutcome.summaryLines;
    }

    const baseObservation = result.success
      ? result.output
      : (`Error: ${result.error}\n${result.output}`).trim();

    const observation = autoFixSummary.length > 0
      ? `${autoFixSummary.join('\n')}\n${baseObservation}`.trim()
      : baseObservation;

    return {
      observation,
      filename: result.filename,
      ...this.parseFinishSignal(observation),
    };
  }

  async executeCli(command: string): Promise<ToolExecutionResult> {
    this.callbacks.onCli?.(command);

    const onStdout = (chunk: string) => process.stdout.write(chunk);
    const onStderr = (chunk: string) => process.stderr.write(chunk);
    const result = await this.session.sandbox.executeCli(command, onStdout, onStderr);
    const observation = result.success
      ? result.output
      : (`Error: ${result.error}\n${result.output}`).trim();

    return {
      observation,
      ...this.parseFinishSignal(observation),
    };
  }

  async writeFileToSandbox(path: string, content: string): Promise<ToolExecutionResult> {
    this.callbacks.onFile?.(path, content);

    try {
      const sandboxRoot = resolve(this.session.sandbox.directory);
      const fullPath = resolve(join(sandboxRoot, path));
      const rel = relative(sandboxRoot, fullPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return {
          observation: `Error writing file ${path}: path resolves outside sandbox`,
        };
      }
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, 'utf-8');
      return {
        observation: `File ${path} created/updated.`,
      };
    } catch (err: any) {
      return {
        observation: `Error writing file ${path}: ${err.message}`,
      };
    }
  }

  async readFileFromSandbox(path: string): Promise<ToolExecutionResult> {
    try {
      const sandboxRoot = resolve(this.session.sandbox.directory);
      const fullPath = resolve(join(sandboxRoot, path));
      const rel = relative(sandboxRoot, fullPath);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return {
          observation: `Error reading file ${path}: path resolves outside sandbox`,
        };
      }
      const { readFile } = await import('fs/promises');
      const content = await readFile(fullPath, 'utf-8');
      return {
        observation: content,
      };
    } catch (err: any) {
      return {
        observation: `Error reading file ${path}: ${err.message}`,
      };
    }
  }

  async applySearchReplaceEdit(filename: string, content: string): Promise<ToolExecutionResult> {
    this.callbacks.onFile?.(filename, content);

    const edits = this.session.sandbox.parseSearchReplace(content);
    if (edits.length === 0) {
      return {
        observation: `Edit for ${filename}: No valid SEARCH/REPLACE blocks found.\nSupported formats:\n1. Standard:\n<<<< SEARCH\ntext\n>>>>\n<<<< REPLACE\nreplacement\n>>>>\n\n2. Git-style:\n<<<< SEARCH\ntext\n=======\nreplacement\n>>>>`,
      };
    }

    const result = await this.session.sandbox.applySearchReplace(filename, edits);
    if (result.success) {
      return {
        observation: result.output,
        filename: result.filename,
      };
    }

    if (this.isMissingFileError(result.error)) {
      const recoveredContent = this.buildRecoveryContentFromEdits(edits);
      if (recoveredContent !== null) {
        const recovered = await this.writeFileToSandbox(filename, recoveredContent);
        if (!recovered.observation.startsWith('Error')) {
          return {
            observation: `${result.error || 'File not found.'}\nRecovered by creating "${filename}" from edit payload.`,
          };
        }
        return recovered;
      }

      const base = `${result.output}\n${result.error || ''}`.trim();
      return {
        observation: `${base}\nRecovery hint: for missing files, use one edit block or ensure all SEARCH blocks are empty so content can be created automatically.`,
        filename: result.filename,
      };
    }

    return {
      observation: `${result.output}\n${result.error || ''}`.trim(),
      filename: result.filename,
    };
  }

  /**
   * Execute provider-native tool call (`action`, `cli`, `file`).
   */
  async executeProviderToolCall(toolCall: ProviderToolCall): Promise<ToolExecutionResult> {
    const toolName = this.normalizeToolName(toolCall.name);
    const args = this.toRecord(toolCall.arguments);

    if (isCompletionToolName(toolName)) {
      const finishMessage = this.extractFirstString(args, FINISH_ARG_KEYS) || this.extractEmbeddedFinishMessage(args);
      if (!finishMessage.trim()) {
        return { observation: `Error: ${PRIMARY_COMPLETION_FUNCTION} requires a non-empty "message" argument.` };
      }
      return {
        observation: `${PRIMARY_COMPLETION_FUNCTION} accepted.`,
        finishMessage: finishMessage.trim(),
      };
    }

    if (toolName === 'action') {
      const content = this.extractFirstString(args, CONTENT_ARG_KEYS);
      if (!content.trim()) {
        return { observation: 'Error: action requires a non-empty "content" argument.' };
      }
      return this.executeAction(content);
    }

    if (toolName === 'cli') {
      const content = this.extractFirstString(args, CONTENT_ARG_KEYS);
      if (!content.trim()) {
        return { observation: 'Error: cli requires a non-empty "content" argument.' };
      }
      return this.executeCli(content);
    }

    if (toolName === 'edit_file' || toolName === 'file') {
      const payload = this.extractFilePayload(args);
      const filename = this.normalizeFilename(payload.filename);
      const content = payload.content;

      if (!filename.trim()) {
        return { observation: `Error: ${toolName} requires a non-empty "filename" argument.` };
      }

      // Single-file mode: content is either full file body or SEARCH/REPLACE edit payload.
      const parsedEdits = this.session.sandbox.parseSearchReplace(content);
      if (parsedEdits.length > 0) {
        return this.applySearchReplaceEdit(filename, content);
      }

      return this.writeFileToSandbox(filename, content);
    }

    if (toolName === 'view_file' || toolName === 'read_file') {
      const payload = this.extractFilePayload(args);
      const filename = this.normalizeFilename(payload.filename);

      if (!filename.trim()) {
        return { observation: `Error: ${toolName} requires a non-empty "filename" argument.` };
      }

      return this.readFileFromSandbox(filename);
    }

    return {
      observation: `Error: Unsupported tool "${toolCall.name}". Supported tools: ${SUPPORTED_TOOLS}. Legacy alias: ${LEGACY_COMPLETION_FUNCTION}.`,
    };
  }

  private isMissingFileError(error?: string): boolean {
    if (!error) return false;
    return /file not found/i.test(error) || /enoent/i.test(error);
  }

  private buildRecoveryContentFromEdits(edits: Array<{ search: string; replace: string }>): string | null {
    if (edits.length === 0) return null;
    if (edits.length === 1) {
      return edits[0]?.replace ?? '';
    }
    const allSearchEmpty = edits.every(edit => !(edit.search || '').trim());
    if (!allSearchEmpty) return null;
    return edits.map(edit => edit.replace ?? '').join('\n');
  }

  private normalizeToolName(name: unknown): string {
    return String(name ?? '').trim().toLowerCase();
  }

  private toRecord(value: unknown): ToolArguments {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }
    return value as ToolArguments;
  }

  private extractFirstString(args: ToolArguments, keys: readonly string[]): string {
    for (const key of keys) {
      if (!(key in args)) continue;
      const value = args[key];
      const text = this.coerceToString(value);
      if (text.trim()) return text;
    }
    return '';
  }

  private coerceToString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private extractEmbeddedObject(candidate: unknown): ToolArguments | null {
    if (!candidate) return null;
    if (typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as ToolArguments;
    }
    if (typeof candidate !== 'string') return null;

    let text = candidate.trim();
    for (let depth = 0; depth < 3; depth++) {
      if (!text) return null;
      try {
        const parsed = JSON.parse(text);
        if (!parsed) return null;
        if (typeof parsed === 'string') {
          text = parsed.trim();
          continue;
        }
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as ToolArguments;
        }
        return null;
      } catch {
        return null;
      }
    }

    return null;
  }

  private extractFilePayload(args: ToolArguments): { filename: string; content: string } {
    let filename = this.extractFirstString(args, FILE_ARG_KEYS);
    let content = this.extractFirstString(args, CONTENT_ARG_KEYS);
    const directContentRaw = this.extractFirstRaw(args, CONTENT_ARG_KEYS);
    const embeddedFromContent = this.extractEmbeddedObject(directContentRaw);
    if (embeddedFromContent) {
      if (!filename.trim()) {
        filename = this.extractFirstString(embeddedFromContent, FILE_ARG_KEYS);
      }
      const embeddedContent = this.extractFirstString(embeddedFromContent, CONTENT_ARG_KEYS);
      if (embeddedContent.trim()) {
        content = embeddedContent;
      }
    }

    const candidates: unknown[] = [];
    for (const key of CONTENT_ARG_KEYS) {
      if (key in args) candidates.push(args[key]);
    }
    for (const value of Object.values(args)) {
      candidates.push(value);
    }

    for (const candidate of candidates) {
      const embedded = this.extractEmbeddedObject(candidate);
      if (!embedded) continue;
      if (!filename.trim()) {
        filename = this.extractFirstString(embedded, FILE_ARG_KEYS);
      }
      if (!content.trim()) {
        content = this.extractFirstString(embedded, CONTENT_ARG_KEYS);
      }
      if (filename.trim() && content.trim()) break;
    }

    return { filename, content };
  }

  private extractFirstRaw(args: ToolArguments, keys: readonly string[]): unknown {
    for (const key of keys) {
      if (key in args) return args[key];
    }
    return undefined;
  }

  private extractEmbeddedFinishMessage(args: ToolArguments): string {
    for (const value of Object.values(args)) {
      const embedded = this.extractEmbeddedObject(value);
      if (!embedded) continue;
      const finish = this.extractFirstString(embedded, FINISH_ARG_KEYS);
      if (finish.trim()) return finish;
    }
    return '';
  }

  private normalizeFilename(rawFilename: string): string {
    let filename = rawFilename.trim();
    filename = filename.replace(/^[`'"]+|[`'"]+$/g, '').trim();
    filename = filename.replace(/\\/g, '/');

    // Heal typo pattern like ".documentation/file.md" -> "./documentation/file.md"
    const typoMatch = filename.match(/^\.([A-Za-z0-9_-][^/]*)\/(.+)$/);
    if (typoMatch) {
      const dir = typoMatch[1];
      const rest = typoMatch[2];
      filename = `./${dir}/${rest}`;
    }

    return filename;
  }

  private parseFinishSignal(observation: string): { finishMessage?: string; finishParseError?: string } {
    const finishMatch = observation.match(COMPLETION_SIGNAL_REGEX);
    if (!finishMatch) {
      return {};
    }

    const raw = finishMatch[1];
    if (!raw) {
      return { finishParseError: `${PRIMARY_COMPLETION_FUNCTION} signal was found but payload is empty.` };
    }

    try {
      const finishMessage = JSON.parse(raw);
      if (typeof finishMessage === 'string') {
        return { finishMessage };
      }
      return { finishParseError: `${PRIMARY_COMPLETION_FUNCTION} payload must be a JSON string.` };
    } catch (error: any) {
      return { finishParseError: `Failed to parse ${PRIMARY_COMPLETION_FUNCTION} payload: ${error.message}` };
    }
  }
}

export default ToolExecutionEngine;
