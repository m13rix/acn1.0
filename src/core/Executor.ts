/**
 * Executor
 *
 * Main orchestrator for the agent loop.
 * Handles the full cycle of:
 * 1. Sending messages to the provider
 * 2. Processing responses
 * 3. Executing actions in sandbox
 * 4. Appending observations
 * 5. Continuing until complete
 */

import type { Session, SessionSnapshot } from './Session.js';
import type { ProviderConfig } from '../types/index.js';
import { ToolExecutionEngine } from './ToolExecutionEngine.js';
import { runForegroundTask } from './ExecutionGate.js';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { getMemoryRuntime } from '../memory_system/index.js';
import { runAiSdkTextAgent } from '../ai-sdk/text-agent-runtime.js';
import { getInstructionAlgorithmService } from '../instruction-algorithm/Service.js';

/**
 * Streaming callbacks following industry-standard patterns
 */
export interface StreamCallbacks {
  /** Called when reasoning content is streamed */
  onReasoningDelta?: (delta: string, accumulated: string) => void;
  /** Called when reasoning completes */
  onReasoningDone?: (fullReasoning: string) => void;
  /** Called when text content is streamed */
  onTextDelta?: (delta: string, accumulated: string) => void;
  /** Called when text completes */
  onTextDone?: (fullText: string) => void;
}

export interface ExecutorCallbacks extends StreamCallbacks {
  onThinking?: (content: string) => void;
  onAction?: (code: string) => void;
  onCli?: (command: string) => void;
  onFile?: (filename: string, content: string) => void;
  onObservation?: (output: string) => void;
  onModelSelected?: (model: string, provider: string, reason?: string) => void;
  onResponse?: (content: string) => void;
  onError?: (error: Error) => void;
  onBeforeProviderCall?: (messages: any[], config: ProviderConfig, actualRequest?: any) => void;
  onMemoryHintsRetrieved?: (content: string, score: number) => void;
  onMemoryHintsSearched?: (topScore: number | null) => void;
  /** @deprecated Use onTextDelta instead */
  onStreamChunk?: (delta: string, accumulated: string) => void;
}

export interface ExecutorCheckpointMetadata {
  reason: string;
}

export interface ExecutorOptions {
  maxIterations?: number;
  stream?: boolean;
  callbacks?: ExecutorCallbacks;
  requireFinish?: boolean;
  onCheckpoint?: (snapshot: SessionSnapshot, metadata: ExecutorCheckpointMetadata) => void | Promise<void>;
}

export interface ExecutorRunOptions {
  continueActiveTurn?: boolean;
}

const DEFAULT_MAX_ITERATIONS = 500;

export class Executor {
  private session: Session;
  private options: ExecutorOptions;

  constructor(session: Session, options: ExecutorOptions = {}) {
    this.session = session;
    this.options = {
      maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      stream: options.stream ?? false,
      callbacks: options.callbacks ?? {},
      requireFinish: options.requireFinish ?? true,
      onCheckpoint: options.onCheckpoint,
    };
  }

  /**
   * Execute a user message and return the final response
   */
  async execute(userMessage: string, runOptions: ExecutorRunOptions = {}): Promise<string> {
    return runForegroundTask(async () => {
      const continueActiveTurn = runOptions.continueActiveTurn === true && this.session.hasActiveTurn();
      const turnUserMessage = continueActiveTurn
        ? (this.session.getActiveTurnUserMessage() || userMessage)
        : userMessage;

      if (!continueActiveTurn) {
        this.session.addUserMessage(getInstructionAlgorithmService().decorateInitialUserMessage(this.session, turnUserMessage));
        await this.checkpoint('turn-started');
      }

      // Shared execution helper for action/cli/file flows
      const toolEngine = new ToolExecutionEngine(this.session, {
        onAction: this.options.callbacks?.onAction,
        onCli: this.options.callbacks?.onCli,
        onFile: this.options.callbacks?.onFile,
      });

      if (this.session.agent.config.memory?.enabled !== false) {
        await this.session.refreshMemoryContext(turnUserMessage, this.options.callbacks);
        this.session.injectVisibleMemoryHintsIntoLastUserMessage();
        await this.checkpoint('memory-refreshed');
      }

      const aiSdkResult = await runAiSdkTextAgent({
        session: this.session,
        options: this.options,
        processFileMessages: this.processFileMessages.bind(this),
        processMemoryMessages: this.processMemoryMessages.bind(this),
        toolEngine,
      });
      this.session.clearExecutionState();
      await this.checkpoint('ai-sdk-text-complete');
      return aiSdkResult;
    });
  }

  private async checkpoint(reason: string): Promise<void> {
    if (!this.options.onCheckpoint) {
      return;
    }

    await this.options.onCheckpoint(this.session.exportSnapshot(), { reason });
  }

  /**
   * Process file messages from .telos-files.json
   * Reads the file, adds file messages to session, and deletes the file
   */
  private async processFileMessages(): Promise<void> {
    const filesJsonPath = join(this.session.sandbox.directory, '.telos-files.json');

    try {
      // Check if file exists
      const content = await readFile(filesJsonPath, 'utf-8');
      const files = JSON.parse(content) as Array<{ content: string; filename: string }>;

      // Add each file as a file message to the session
      for (const file of files) {
        this.session.addFileMessage(file.content, file.filename);
      }

      // Delete the file after processing
      await unlink(filesJsonPath);
    } catch (error: any) {
      // File doesn't exist or error reading - ignore (not an error condition)
      if (error.code !== 'ENOENT') {
        // Only log non-ENOENT errors (file not found is expected if no files were viewed)
        console.warn(`[Executor] Failed to process file messages: ${error.message}`);
      }
    }
  }

  private async processMemoryMessages(): Promise<void> {
    const memoryJsonPath = join(this.session.sandbox.directory, '.telos-memory.json');

    try {
      const content = await readFile(memoryJsonPath, 'utf-8');
      if (this.session.agent.config.memory?.enabled === false) {
        await unlink(memoryJsonPath);
        return;
      }

      const payload = JSON.parse(content) as {
        searches?: Array<{ factIds?: string[]; text?: string }>;
        noteEvents?: Array<{ action?: 'upsert' | 'remove'; noteId?: string; sourceLabel?: string }>;
      };

      for (const search of payload.searches || []) {
        const factIds = Array.isArray(search.factIds)
          ? search.factIds.map((factId) => String(factId || '').trim()).filter(Boolean)
          : [];
        if (factIds.length > 0) {
          this.session.markMemoryFactsAsSurfaced(factIds);
        }
      }

      if ((payload.noteEvents || []).length > 0) {
        const runtime = await getMemoryRuntime(this.session.agent.config.memory);
        for (const event of payload.noteEvents || []) {
          const noteId = String(event.noteId || '').trim();
          if (!noteId) {
            continue;
          }
          if (event.action === 'remove') {
            await runtime.notesSync.notifyNoteRemoval(noteId);
          } else {
            await runtime.notesSync.notifyNoteUpsert(noteId, event.sourceLabel);
          }
        }
      }

      await unlink(memoryJsonPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        console.warn(`[Executor] Failed to process memory messages: ${error.message}`);
      }
    }
  }
}

export default Executor;
