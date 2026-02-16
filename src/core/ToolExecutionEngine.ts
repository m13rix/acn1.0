/**
 * ToolExecutionEngine
 *
 * Shared execution logic for action/cli/file operations.
 * Used by legacy syntax loops and provider-native tool-calling loops.
 */

import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { ProviderToolCall } from '../types/index.js';
import { actionContext } from './ActionContext.js';
import { agentContext } from './AgentContext.js';
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

const FINISH_REGEX = /__ACN_FINISH_START__(.*?)__ACN_FINISH_END__/s;

export class ToolExecutionEngine {
  constructor(
    private readonly session: Session,
    private readonly callbacks: ToolExecutionCallbacks = {}
  ) {}

  async executeAction(code: string): Promise<ToolExecutionResult> {
    this.callbacks.onAction?.(code);

    const env = actionContext.getStore()?.env || {};
    env.AGENT_DEPTH = String(agentContext.getStore()?.depth ?? 0);

    const onStderr = (chunk: string) => process.stderr.write(chunk);
    const result = await this.session.sandbox.execute(code, undefined, env, onStderr);
    const observation = result.success
      ? result.output
      : (`Error: ${result.error}\n${result.output}`).trim();

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
      const fullPath = join(this.session.sandbox.directory, path);
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

    return {
      observation: `${result.output}\n${result.error || ''}`.trim(),
      filename: result.filename,
    };
  }

  /**
   * Execute provider-native tool call (`action`, `cli`, `file`).
   */
  async executeProviderToolCall(toolCall: ProviderToolCall): Promise<ToolExecutionResult> {
    const args = toolCall.arguments || {};

    if (toolCall.name === 'action') {
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      if (!content.trim()) {
        return { observation: 'Error: action requires a non-empty "content" argument.' };
      }
      return this.executeAction(content);
    }

    if (toolCall.name === 'cli') {
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      if (!content.trim()) {
        return { observation: 'Error: cli requires a non-empty "content" argument.' };
      }
      return this.executeCli(content);
    }

    if (toolCall.name === 'file') {
      const filename = typeof args['filename'] === 'string' ? args['filename'] : '';
      const content = typeof args['content'] === 'string' ? args['content'] : '';

      if (!filename.trim()) {
        return { observation: 'Error: file requires a non-empty "filename" argument.' };
      }

      // Single-file mode: content is either full file body or SEARCH/REPLACE edit payload.
      const parsedEdits = this.session.sandbox.parseSearchReplace(content);
      if (parsedEdits.length > 0) {
        return this.applySearchReplaceEdit(filename, content);
      }

      return this.writeFileToSandbox(filename, content);
    }

    return {
      observation: `Error: Unsupported tool "${toolCall.name}". Supported tools: action, cli, file.`,
    };
  }

  private parseFinishSignal(observation: string): { finishMessage?: string; finishParseError?: string } {
    const finishMatch = observation.match(FINISH_REGEX);
    if (!finishMatch) {
      return {};
    }

    const raw = finishMatch[1];
    if (!raw) {
      return { finishParseError: 'FINISH signal was found but payload is empty.' };
    }

    try {
      const finishMessage = JSON.parse(raw);
      if (typeof finishMessage === 'string') {
        return { finishMessage };
      }
      return { finishParseError: 'FINISH payload must be a JSON string.' };
    } catch (error: any) {
      return { finishParseError: `Failed to parse FINISH payload: ${error.message}` };
    }
  }
}

export default ToolExecutionEngine;
