/**
 * ACN - Agentic AI Framework
 * 
 * Main entry point and public API exports
 */

// Core
export { Session, Executor, PromptBuilder } from './core/index.js';
export type { SessionComponents, ExecutorCallbacks, ExecutorOptions } from './core/index.js';

// Providers
export { BaseProvider, registerProvider, getProvider, getAvailableProviders } from './providers/base.js';
export { GeminiProvider } from './providers/gemini.js';
export { BaseVoiceProvider, getVoiceProvider, getAvailableVoiceProviders } from './providers/voice/index.js';
export { GeminiVoiceProvider } from './providers/voice/gemini-voice.js';

// Syntax
export { BaseSyntax, registerSyntax, getSyntax, getAvailableSyntax } from './syntax/base.js';
export { XMLTagsSyntax } from './syntax/xml-tags.js';

// Loops
export { BaseLoop, registerLoop, getLoop, getAvailableLoops } from './loops/base.js';
export { AccumulatorLoop } from './loops/accumulator.js';

// Loaders
export { AgentLoader } from './loaders/AgentLoader.js';
export { ToolLoader } from './loaders/ToolLoader.js';

// Sandbox
export { Sandbox } from './sandbox/Sandbox.js';

// Interfaces
export * from './interfaces/index.js';

// Types
export * from './types/index.js';

// Utils
export { loadEnv, hasEnvFile } from './utils/env.js';

// Register all built-in modules
import './providers/index.js';
import './providers/voice/index.js';
import './syntax/index.js';
import './loops/index.js';
