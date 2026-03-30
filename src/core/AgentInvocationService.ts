import { AgentLoader } from '../loaders/AgentLoader.js';
import type { AgentInterfaceName, AgentInvocationOptions, LoadedAgent } from '../types/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import { runAgent } from './AgentRunner.js';
import { getDefaultInterfaceManager } from '../interfaces/InterfaceManager.js';

export interface CallAgentOptions extends AgentInvocationOptions {
  agent: string | LoadedAgent;
  message: string;
  sandbox: ISandbox;
  parentDepth?: number;
  extraSystemPrompt?: string;
  stream?: boolean;
  modelOverride?: string;
  systemPromptOverride?: string;
  isSubagent?: boolean;
  routeEnv?: Record<string, string>;
}

export class AgentInvocationService {
  private readonly agentLoader: AgentLoader;

  constructor(agentLoader?: AgentLoader) {
    this.agentLoader = agentLoader || new AgentLoader();
  }

  async callAgent(options: CallAgentOptions): Promise<string> {
    const loadedAgent = typeof options.agent === 'string'
      ? await this.loadAgentCaseInsensitive(options.agent)
      : options.agent;

    if (!loadedAgent) {
      throw new Error(`Agent "${String(options.agent)}" not found.`);
    }

    const agent: LoadedAgent = {
      ...loadedAgent,
      config: {
        ...loadedAgent.config,
      },
      systemPromptContent: loadedAgent.systemPromptContent,
      subagentPromptContent: loadedAgent.subagentPromptContent,
    };

    if (options.modelOverride) {
      agent.config.model = options.modelOverride;
    }
    if (options.systemPromptOverride) {
      agent.systemPromptContent = options.systemPromptOverride;
    }
    if (options.extraSystemPrompt) {
      agent.systemPromptContent = `[Sub-agent additional context]\n${options.extraSystemPrompt}\n\n---\n\n${agent.systemPromptContent}`;
    }
    if (options.isSubagent) {
      agent.config.skillsTable = undefined;
    }

    const modality = agent.config.modality || 'text';
    const targetInterface = this.resolveInterface(agent, options.interface);

    if (modality === 'voice') {
      const interfaceManager = getDefaultInterfaceManager();
      return interfaceManager.invokeAgent(targetInterface, {
        agent,
        request: options.message,
        sandbox: options.sandbox,
        routeEnv: options.routeEnv,
      });
    }

    return runAgent({
      agent,
      message: options.message,
      sandbox: options.sandbox,
      parentDepth: options.parentDepth,
      extraSystemPrompt: options.extraSystemPrompt,
      stream: options.stream,
      modelOverride: options.modelOverride,
      systemPromptOverride: options.systemPromptOverride,
      isSubagent: options.isSubagent,
    });
  }

  private resolveInterface(agent: LoadedAgent, overrideInterface?: AgentInterfaceName): AgentInterfaceName {
    const modality = agent.config.modality || 'text';
    const targetInterface = overrideInterface || agent.config.interface || 'telegram';

    if (modality === 'voice' && targetInterface === 'telegram') {
      throw new Error(`Voice agent "${agent.config.name}" cannot be invoked through interface "${targetInterface}".`);
    }

    return targetInterface;
  }

  private async loadAgentCaseInsensitive(name: string): Promise<LoadedAgent | null> {
    const direct = await this.agentLoader.loadByName(name);
    if (direct) {
      return direct;
    }

    const available = await this.agentLoader.getAvailableAgents();
    const match = available.find((agentName) => agentName.toLowerCase() === name.toLowerCase());
    if (!match) {
      return null;
    }

    return this.agentLoader.loadByName(match);
  }
}

const defaultAgentInvocationService = new AgentInvocationService();

export function getAgentInvocationService(): AgentInvocationService {
  return defaultAgentInvocationService;
}
