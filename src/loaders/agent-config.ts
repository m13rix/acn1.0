import type { AgentConfig, AgentInterfaceName, AgentModality } from '../types/index.js';

const TEXT_PROVIDER_DEFAULT_INTERFACE: AgentInterfaceName = 'telegram';
const TEXT_PROVIDER_DEFAULT_MODALITY: AgentModality = 'text';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentConfig(config: AgentConfig): AgentConfig {
  const normalized: AgentConfig = {
    ...config,
    modality: config.modality || TEXT_PROVIDER_DEFAULT_MODALITY,
    interface: config.interface || TEXT_PROVIDER_DEFAULT_INTERFACE,
    providerOptions: isPlainObject(config.providerOptions) ? { ...config.providerOptions } : undefined,
    interfaceOptions: isPlainObject(config.interfaceOptions) ? { ...config.interfaceOptions } : undefined,
  };

  return normalized;
}

export function validateAgentConfig(config: AgentConfig): void {
  const modality = config.modality || TEXT_PROVIDER_DEFAULT_MODALITY;
  const agentInterface = config.interface || TEXT_PROVIDER_DEFAULT_INTERFACE;

  if (modality !== 'text' && modality !== 'voice') {
    throw new Error(`Unsupported agent modality "${String(modality)}". Expected "text" or "voice".`);
  }

  if (!agentInterface || !String(agentInterface).trim()) {
    throw new Error('Agent interface must be a non-empty string.');
  }

  if (modality === 'voice' && config.stream === false) {
    throw new Error('Voice agents require streaming transport; remove stream: false from the config.');
  }

  const launchDefault = config.interfaceOptions?.['launchDefault'];
  if (launchDefault !== undefined && typeof launchDefault !== 'boolean') {
    throw new Error('interfaceOptions.launchDefault must be a boolean when provided.');
  }
}

export function getDefaultAgentModality(): AgentModality {
  return TEXT_PROVIDER_DEFAULT_MODALITY;
}

export function getDefaultAgentInterface(): AgentInterfaceName {
  return TEXT_PROVIDER_DEFAULT_INTERFACE;
}
