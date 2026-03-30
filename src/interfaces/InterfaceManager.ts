import { AgentLoader } from '../loaders/AgentLoader.js';
import type { LoadedAgent } from '../types/index.js';
import type {
  AgentInterfaceRuntime,
  InterfaceAgentInvocationOptions,
  InterfaceRouteHandler,
  InterfaceRuntimeContext,
} from './base.js';
import { getInterfaceRouteRegistry } from './registry.js';

export class InterfaceManager implements InterfaceRuntimeContext {
  private readonly agentLoader: AgentLoader;
  private readonly runtimes = new Map<string, AgentInterfaceRuntime>();
  private readonly started = new Set<string>();

  constructor(agentLoader?: AgentLoader) {
    this.agentLoader = agentLoader || new AgentLoader();
  }

  registerRuntime(runtime: AgentInterfaceRuntime): void {
    this.runtimes.set(runtime.name, runtime);
  }

  async startConfiguredInterfaces(): Promise<void> {
    const agents = await this.getLoadedAgents();
    const requiredInterfaces = new Set<string>();

    for (const agent of agents) {
      requiredInterfaces.add(agent.config.interface || 'telegram');
    }

    for (const interfaceName of requiredInterfaces) {
      if (this.started.has(interfaceName)) {
        continue;
      }
      const runtime = this.runtimes.get(interfaceName);
      if (!runtime) {
        throw new Error(`Interface "${interfaceName}" is not registered.`);
      }
      await runtime.start(this);
      this.started.add(interfaceName);
    }
  }

  async stopAll(): Promise<void> {
    for (const interfaceName of Array.from(this.started)) {
      const runtime = this.runtimes.get(interfaceName);
      if (runtime?.stop) {
        await runtime.stop();
      }
      this.started.delete(interfaceName);
    }
  }

  registerRoute(handler: InterfaceRouteHandler): void {
    getInterfaceRouteRegistry().register(handler);
  }

  unregisterRoute(routeId: string): void {
    getInterfaceRouteRegistry().unregister(routeId);
  }

  getRegisteredRoutes(): InterfaceRouteHandler[] {
    return getInterfaceRouteRegistry().list();
  }

  async getLoadedAgents(): Promise<LoadedAgent[]> {
    return this.agentLoader.loadAll();
  }

  async invokeAgent(interfaceName: string, options: InterfaceAgentInvocationOptions): Promise<string> {
    const runtime = this.runtimes.get(interfaceName);
    if (!runtime?.invokeAgent) {
      throw new Error(`Interface "${interfaceName}" does not support programmatic agent invocation.`);
    }
    if (!this.started.has(interfaceName)) {
      await runtime.start(this);
      this.started.add(interfaceName);
    }
    return runtime.invokeAgent(options);
  }

  getRuntime<T extends AgentInterfaceRuntime = AgentInterfaceRuntime>(interfaceName: string): T | undefined {
    return this.runtimes.get(interfaceName) as T | undefined;
  }
}

let defaultInterfaceManager: InterfaceManager | null = null;

export function setDefaultInterfaceManager(manager: InterfaceManager): void {
  defaultInterfaceManager = manager;
}

export function getDefaultInterfaceManager(): InterfaceManager {
  if (!defaultInterfaceManager) {
    defaultInterfaceManager = new InterfaceManager();
  }
  return defaultInterfaceManager;
}
