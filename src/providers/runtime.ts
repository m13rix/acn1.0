import type { LoadedAgent, Provider, VoiceProvider } from '../types/index.js';
import { getProvider } from './index.js';
import { getVoiceProvider } from './voice/index.js';

export function getAgentTextProvider(agent: LoadedAgent): Provider {
  return getProvider(agent.config.provider || 'openrouter');
}

export function getAgentVoiceProvider(agent: LoadedAgent): VoiceProvider {
  return getVoiceProvider(agent.config.provider || 'gemini-voice');
}

export function isVoiceAgent(agent: LoadedAgent): boolean {
  return (agent.config.modality || 'text') === 'voice';
}
