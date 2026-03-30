import type { VoiceProvider } from '../../types/index.js';

const registry = new Map<string, () => VoiceProvider>();

export function registerVoiceProvider(name: string, factory: () => VoiceProvider): void {
  registry.set(name, factory);
}

export function getVoiceProvider(name: string): VoiceProvider {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Voice provider "${name}" not found. Available: ${Array.from(registry.keys()).join(', ')}`);
  }
  return factory();
}

export function getAvailableVoiceProviders(): string[] {
  return Array.from(registry.keys());
}
