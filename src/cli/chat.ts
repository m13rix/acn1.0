#!/usr/bin/env node
/**
 * Interactive CLI for testing agents
 */

// Load .env file first, before any other imports
import { config } from 'dotenv';
import * as readline from 'node:readline';
import chalk from 'chalk';
import { AgentLoader } from '../loaders/AgentLoader.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { Session } from '../core/Session.js';
import { Executor } from '../core/Executor.js';
import { SCORE_THRESHOLD as SKILLS_SCORE_THRESHOLD } from '../skills_system/SkillsService.js';
import { getProvider } from '../providers/base.js';
import { getSyntax } from '../syntax/base.js';

import { getLoop } from '../loops/base.js';
import { TelegramService } from '../services/TelegramService.js';
import { HeartbeatService } from '../heartbeat/HeartbeatService.js';
import { COLORS, SYMBOLS, StreamDisplay } from './display.js';
import { runWithAgentContext } from '../core/AgentContext.js';
import { setGlobalDisplay } from '../core/GlobalDisplay.js';

// Import to register all modules
import '../providers/index.js';
import '../syntax/index.js';
import '../loops/index.js';

config();

const agentLoader = new AgentLoader();
const toolLoader = new ToolLoader();

// Streaming is ON by default, use --no-stream to disable
const disableStreaming = process.argv.includes('--no-stream');
const enableStreaming = !disableStreaming;
let debugMode = false;

// UI Constants


async function selectAgent(): Promise<string> {
  const agents = await agentLoader.getAvailableAgents();

  if (agents.length === 0) {
    console.log(COLORS.error('No agents found in ./agents directory'));
    console.log(COLORS.muted('Create an agent directory with agent.yaml and system.md files'));
    process.exit(1);
  }

  if (agents.length === 1) {
    console.log(COLORS.muted(`Using agent: ${agents[0]}`));
    return agents[0]!;
  }

  console.log(COLORS.primary('\nAvailable agents:'));
  agents.forEach((name, i) => {
    console.log(COLORS.text(`  ${i + 1}. ${name}`));
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(COLORS.primary('\nSelect agent (number or name): '), (answer) => {
      rl.close();

      const num = parseInt(answer, 10);
      if (!isNaN(num) && num >= 1 && num <= agents.length) {
        resolve(agents[num - 1]!);
      } else if (agents.includes(answer)) {
        resolve(answer);
      } else {
        console.log(COLORS.muted(`Using first agent: ${agents[0]}`));
        resolve(agents[0]!);
      }
    });
  });
}

async function createSession(agentName: string): Promise<Session> {
  console.log(COLORS.muted(`Loading agent "${agentName}"...`));

  const agent = await agentLoader.loadByName(agentName);
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found`);
  }

  const provider = getProvider(agent.config.provider || 'gemini');
  const syntax = getSyntax(agent.config.syntax);
  const loop = getLoop(agent.config.loop);

  // Load tools
  const toolNames = [...(agent.config.tools || [])];
  if (!toolNames.includes('files')) toolNames.push('files');
  if (agent.config.skillsTable && !toolNames.includes('skills')) toolNames.push('skills');
  if (agent.config.memory && agent.config.memory.enabled !== false && !toolNames.includes('memory')) {
    toolNames.push('memory');
  }

  const tools = await toolLoader.loadByNames(toolNames);

  console.log(COLORS.muted(`Provider: ${agent.config.provider || 'gemini'} | Tools: ${tools.map(t => t.config.name).join(', ') || 'none'}`));

  const session = new Session({
    agent,
    provider,
    syntax,
    loop,
    tools,
  });

  await session.initialize();

  console.log(COLORS.secondary(`Session: ${session.id}`));

  return session;
}

/**
 * Manages the streaming display state
 */


/**
 * Extract words from text using Unicode-aware regex
 */
function extractWords(text: string): string[] {
  const matches = text.match(/\p{L}[\p{L}\p{N}_-]*/gu) || [];
  return matches.filter(w => w.length > 1);
}

async function runChat(session: Session, telegramService?: TelegramService): Promise<void> {
  const display = new StreamDisplay();

  // Set global display for agents tool to use
  setGlobalDisplay(display);

  // Real-time embedding state (kept for compatibility, but unused)
  let currentInput = '';
  let currentWord = '';

  const executorOptions = {
    maxIterations: 500,
    stream: enableStreaming,
    requireFinish: session.agent.config.requireFinish,
    callbacks: {
      // Streaming callbacks
      onReasoningDelta: (delta: string) => {
        if (!enableStreaming) return;
        display.startReasoning();
        display.writeReasoning(delta);
      },
      onReasoningDone: () => {
        if (!enableStreaming) return;
        display.endReasoning();
      },
      onTextDelta: (delta: string) => {
        if (!enableStreaming) return;
        display.startText();
        display.writeText(delta);
      },
      onTextDone: () => {
        if (!enableStreaming) return;
        display.endText();
      },

      // Skills callbacks
      onSkillsRetrieved: (content: string, score: number) => {
        console.log(COLORS.skills(`\n${SYMBOLS.skills} Skills retrieved (${(score * 100).toFixed(0)}% match)`));
        const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
        console.log(COLORS.muted(`  ${preview}`));
      },
      onSkillsSearched: (topScore: number | null) => {
        if (debugMode && topScore !== null) {
          console.log(COLORS.muted(`\n  Skills: top score ${(topScore * 100).toFixed(0)}% (below ${(SKILLS_SCORE_THRESHOLD * 100).toFixed(0)}% threshold)`));
        }
      },

      // Executor lifecycle callbacks
      onThinking: (content: string) => {
        // Only used in non-streaming mode
        if (!enableStreaming) {
          console.log(COLORS.reasoning(`\n${SYMBOLS.thinking} Thinking...`));
          console.log(COLORS.muted(content));
        }
      },
      onAction: (code: string) => {
        display.showAction(code);
      },
      onObservation: (output: string) => {
        display.showObservation(output);
      },
      onBeforeProviderCall: (messages: any[], config: any, actualRequest: any) => {
        if (debugMode) {
          console.log(COLORS.muted('\n─── DEBUG ───────────────────────────────────'));
          if (actualRequest) {
            console.log(JSON.stringify(actualRequest, null, 2));
          } else {
            console.log(JSON.stringify({ messages, config }, null, 2));
          }
          console.log(COLORS.muted('─────────────────────────────────────────────\n'));
        }
        // Reset display state for new provider call
        display.reset();
      },
    },
  };

  const executor = new Executor(session, executorOptions);

  // Header
  console.log('');
  console.log(COLORS.muted('─'.repeat(50)));
  const statusParts = [COLORS.secondary(`  ${SYMBOLS.complete} Ready`)];
  if (enableStreaming) statusParts.push(COLORS.muted('streaming'));
  if (session.skillsService) statusParts.push(COLORS.skills('skills'));
  console.log(statusParts.join(COLORS.muted(' | ')));
  console.log(COLORS.muted('  Commands: exit, clear, debug, debug on/off'));
  console.log(COLORS.muted('─'.repeat(50)));
  console.log('');

  // Check if we can use raw mode (TTY support)
  const canUseRawMode = process.stdin.isTTY && session.skillsService;

  if (canUseRawMode) {
    // Real-time input mode with raw stdin
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let isProcessing = false;

    const showPrompt = (): void => {
      process.stdout.write(COLORS.primary(`${SYMBOLS.user} `));
    };

    const resetInput = (): void => {
      currentInput = '';
      currentWord = '';
    };

    const handleCommand = async (cmd: string): Promise<boolean> => {
      const lower = cmd.toLowerCase();

      if (lower === 'exit') {
        console.log(COLORS.muted('\nGoodbye!'));
        await session.cleanup();
        process.exit(0);
      }

      if (lower === 'clear') {
        session.clearHistory();
        session.skillsService?.clearHistory();
        console.log(COLORS.muted('Conversation cleared.\n'));
        return true;
      }

      if (lower === 'debug') {
        console.log(COLORS.muted('\n─── System Prompt ───'));
        console.log(session.getSystemPrompt());
        console.log(COLORS.muted('─────────────────────\n'));
        return true;
      }

      if (lower === 'debug on') {
        debugMode = true;
        console.log(COLORS.secondary('Debug mode enabled.\n'));
        return true;
      }

      if (lower === 'debug off') {
        debugMode = false;
        console.log(COLORS.muted('Debug mode disabled.\n'));
        return true;
      }

      return false;
    };

    showPrompt();

    process.stdin.on('data', async (chunk: string) => {
      // Prevent re-entry while processing
      if (isProcessing) return;

      // Ctrl+C - exit
      if (chunk === '\u0003') {
        console.log(COLORS.muted('\n\nSession ended.'));
        await session.cleanup();
        process.exit(0);
      }

      // Backspace
      if (chunk === '\u007f' || chunk === '\b') {
        if (currentInput.length > 0) {
          currentInput = currentInput.slice(0, -1);
          currentWord = currentWord.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }

      // Enter - submit
      if (chunk === '\r' || chunk === '\n') {
        console.log(''); // New line after input

        const trimmed = currentInput.trim();
        if (!trimmed) {
          showPrompt();
          resetInput();
          return;
        }

        // Check for commands
        if (await handleCommand(trimmed)) {
          showPrompt();
          resetInput();
          return;
        }

        // Process message
        isProcessing = true;
        try {
          process.stdout.write(COLORS.secondary(`${SYMBOLS.assistant} `));

          display.reset();
          const response = await runWithAgentContext(
            session.agent.config.name,
            () => executor.execute(trimmed),
            executorOptions.callbacks,
            enableStreaming,
            session.sandbox,
            session.agent.config.modelSwitching,
            session.agent
          );

          if (telegramService) {
            // Run in background to not block CLI
            telegramService.broadcast(`✅ Agent finished executing task.`).catch(console.error);
          }
          display.finalize();

          // In non-streaming mode, print the response
          if (!enableStreaming) {
            console.log(response);
          }

          console.log('');

        } catch (error) {
          display.finalize();
          console.log(COLORS.error(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}`));
          if (debugMode && error instanceof Error && error.stack) {
            console.log(COLORS.muted(error.stack));
          }
          console.log('');
        }

        isProcessing = false;
        resetInput();
        showPrompt();
        return;
      }

      // Paste detected (multiple characters at once)
      if (chunk.length > 1) {
        process.stdout.write(chunk);
        currentInput += chunk;
        return;
      }

      // Normal typing - single character
      process.stdout.write(chunk);
      currentInput += chunk;

      // Check for word boundary
      if (/\s|[.,!?;:'"()\[\]{}]/u.test(chunk)) {
        currentWord = '';
      } else {
        currentWord += chunk;
      }
    });

  } else {
    // Fallback to readline interface
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): void => {
      rl.question(COLORS.primary(`${SYMBOLS.user} `), async (input) => {
        const trimmed = input.trim();

        if (!trimmed) {
          prompt();
          return;
        }

        // Handle commands
        const cmd = trimmed.toLowerCase();

        if (cmd === 'exit') {
          console.log(COLORS.muted('\nGoodbye!'));
          await session.cleanup();
          rl.close();
          process.exit(0);
        }

        if (cmd === 'clear') {
          session.clearHistory();
          session.skillsService?.clearHistory();
          console.log(COLORS.muted('Conversation cleared.\n'));
          prompt();
          return;
        }

        if (cmd === 'debug') {
          console.log(COLORS.muted('\n─── System Prompt ───'));
          console.log(session.getSystemPrompt());
          console.log(COLORS.muted('─────────────────────\n'));
          prompt();
          return;
        }

        if (cmd === 'debug on') {
          debugMode = true;
          console.log(COLORS.secondary('Debug mode enabled.\n'));
          prompt();
          return;
        }

        if (cmd === 'debug off') {
          debugMode = false;
          console.log(COLORS.muted('Debug mode disabled.\n'));
          prompt();
          return;
        }

        // Process message
        try {
          process.stdout.write(COLORS.secondary(`${SYMBOLS.assistant} `));

          display.reset();
          const response = await runWithAgentContext(
            session.agent.config.name,
            () => executor.execute(trimmed),
            executorOptions.callbacks,
            enableStreaming,
            session.sandbox,
            session.agent.config.modelSwitching,
            session.agent
          );

          if (telegramService) {
            telegramService.broadcast(`✅ Agent finished executing task.`).catch(console.error);
          }
          display.finalize();

          // In non-streaming mode, print the response
          if (!enableStreaming) {
            console.log(response);
          }

          console.log('');

        } catch (error) {
          display.finalize();
          console.log(COLORS.error(`\nError: ${error instanceof Error ? error.message : 'Unknown error'}`));
          if (debugMode && error instanceof Error && error.stack) {
            console.log(COLORS.muted(error.stack));
          }
          console.log('');
        }

        prompt();
      });
    };

    prompt();

    // Handle Ctrl+C gracefully
    rl.on('close', async () => {
      console.log(COLORS.muted('\n\nSession ended.'));
      await session.cleanup();
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log(COLORS.primary.bold('  ACN Agent Framework'));
  console.log('');

  // Check for API keys
  if (!process.env['GEMINI_KEY'] && !process.env['OPENROUTER_API_KEY']) {
    console.log(COLORS.reasoning('⚠ No API keys found.'));
    console.log(COLORS.muted('Set GEMINI_KEY or OPENROUTER_API_KEY in your environment.\n'));
  }

  let telegramService: TelegramService | undefined;

  // Start Telegram Bot Service
  try {
    telegramService = new TelegramService();
    await telegramService.start();
  } catch (error) {
    console.error(COLORS.error('Failed to start Telegram Service:'), error);
  }

  // Initialize Heartbeat Service
  try {
    const heartbeat = HeartbeatService.getInstance();
    await heartbeat.initialize();
    await heartbeat.start();
  } catch (error) {
    console.error(COLORS.error('Failed to start Heartbeat Service:'), error);
  }


  try {
    const agentName = await selectAgent();
    const session = await createSession(agentName);
    await runChat(session, telegramService);
  } catch (error) {
    console.error(COLORS.error(`\nFatal error: ${error instanceof Error ? error.message : 'Unknown error'}`));
    if (error instanceof Error && error.stack) {
      console.error(COLORS.muted(error.stack));
    }
    process.exit(1);
  }
}

main();
