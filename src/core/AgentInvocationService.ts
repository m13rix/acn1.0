import { AgentLoader } from '../loaders/AgentLoader.js';
import type { AgentInstructionAlgorithmConfig, AgentInterfaceName, AgentInvocationOptions, LoadedAgent } from '../types/index.js';
import type { ISandbox } from '../sandbox/interfaces.js';
import { runAgent } from './AgentRunner.js';
import { getDefaultInterfaceManager } from '../interfaces/InterfaceManager.js';
import type { SessionSnapshot } from './Session.js';
import type { NotDiamondRoutingResult } from '../services/model-selection/NotDiamondRouter.js';

export interface CallAgentOptions extends AgentInvocationOptions {
  agent: string | LoadedAgent;
  message: string;
  sandbox: ISandbox;
  parentDepth?: number;
  extraSystemPrompt?: string;
  stream?: boolean;
  modelOverride?: string;
  providerOverride?: string;
  systemPromptOverride?: string;
  instructionAlgorithmOverride?: AgentInstructionAlgorithmConfig | false;
  isSubagent?: boolean;
  routeEnv?: Record<string, string>;
  restoreSnapshot?: SessionSnapshot;
  onSessionSnapshot?: (snapshot: SessionSnapshot, agent: LoadedAgent) => void | Promise<void>;
  onModelRouted?: (result: NotDiamondRoutingResult, agent: LoadedAgent) => void | Promise<void>;
  signal?: AbortSignal;
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

    if (options.modelOverride && options.modelOverride.trim().toLowerCase() !== 'auto') {
      agent.config.model = options.modelOverride;
    }
    if (options.providerOverride) {
      agent.config.provider = options.providerOverride;
    }
    if (options.systemPromptOverride) {
      agent.systemPromptContent = options.systemPromptOverride;
    }
    if (options.extraSystemPrompt) {
      agent.systemPromptContent = `[Sub-agent additional context]\n${options.extraSystemPrompt}\n\n---\n\n${agent.systemPromptContent}`;
    }
    if (options.isSubagent) {
      agent.config.memory = {
        ...agent.config.memory,
        autoHints: { enabled: false },
      };
      if (agent.config.adaptiveStepContext) {
        agent.config.adaptiveStepContext = {
          ...agent.config.adaptiveStepContext,
          debug: {
            ...agent.config.adaptiveStepContext.debug,
            enabled: false,
            openBrowser: false,
          },
        };
      }
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
      providerOverride: options.providerOverride,
      systemPromptOverride: options.systemPromptOverride,
      instructionAlgorithmOverride: options.instructionAlgorithmOverride,
      isSubagent: options.isSubagent,
      restoreSnapshot: options.restoreSnapshot,
      onSessionSnapshot: options.onSessionSnapshot,
      onModelRouted: options.onModelRouted,
      signal: options.signal,
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
