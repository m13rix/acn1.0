import type { AgentInterfaceName, AgentModality, LoadedAgent } from '../types/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';

export interface InterfaceUiEventPayload {
  event: string;
  scopeId: string;
  agentName?: string;
  accumulated?: string;
  text?: string;
  code?: string;
  command?: string;
  filename?: string;
  content?: string;
}

export interface InterfaceRouteHandler {
  routeId: string;
  interfaceName: AgentInterfaceName;
  getAgentName?(): string | null | undefined;
  ensureAgent?(preferredAgentName?: string): Promise<void>;
  ask(question: string, preferredAgentName?: string): Promise<string>;
  sendText(text: string, preferredAgentName?: string): Promise<void>;
  sendVoice(filePath: string, preferredAgentName?: string): Promise<void>;
  sendFiles(files: string[], preferredAgentName?: string): Promise<void>;
  sendAuthLink?(text: string, url: string, label?: string, preferredAgentName?: string): Promise<void>;
  emitUiEvent?(payload: InterfaceUiEventPayload): Promise<void>;
}

export interface InterfaceRuntimeContext {
  registerRoute(handler: InterfaceRouteHandler): void;
  unregisterRoute(routeId: string): void;
  getRegisteredRoutes(): InterfaceRouteHandler[];
  getLoadedAgents(): Promise<LoadedAgent[]>;
}

export interface InterfaceAgentInvocationOptions {
  agent: LoadedAgent;
  request: string;
  sandbox: ISandbox;
  routeEnv?: Record<string, string>;
}

export interface AgentInterfaceRuntime {
  name: AgentInterfaceName;
  supportsModality(modality: AgentModality): boolean;
  start(context: InterfaceRuntimeContext): Promise<void>;
  invokeAgent?(options: InterfaceAgentInvocationOptions): Promise<string>;
  stop?(): Promise<void>;
}
