/**
 * Base provider interface and utilities
 * 
 * All providers implement a universal interface using OpenAI-style parameters.
 * Each provider is responsible for mapping these to their native format.
 */

import type { Message, Provider, ProviderConfig, ProviderResponse, ProviderStreamChunk, ProviderStreamEvent } from '../types/index.js';

/**
 * Abstract base class for all providers
 * Provides common utilities and enforces the provider contract
 */
export abstract class BaseProvider implements Provider {
  abstract name: string;
  
  /**
   * Complete a conversation with the model
   * @param messages - Conversation history in OpenAI format
   * @param config - Provider configuration with universal parameters
   */
  abstract complete(messages: Message[], config: ProviderConfig): Promise<ProviderResponse>;

  /**
   * @deprecated Use streamEvents instead
   * Legacy streaming interface for backward compatibility.
   */
  stream?(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamChunk>;

  /**
   * Industry-standard streaming with separate reasoning and text events.
   * Providers should implement this for proper streaming support.
   */
  streamEvents?(messages: Message[], config: ProviderConfig): AsyncIterable<ProviderStreamEvent>;
  
  /**
   * Build the actual provider-specific request object.
   * Used for debugging to see what's actually sent to the provider API.
   * @param messages - Conversation history in universal format
   * @param config - Provider configuration
   * @returns The actual request object that will be sent to the provider
   */
  buildRequest?(messages: Message[], config: ProviderConfig): any;
  
  /**
   * Validate that required configuration is present
   */
  protected validateConfig(config: ProviderConfig): void {
    if (!config.model) {
      throw new Error('Model is required in provider config');
    }
  }
  
  /**
   * Apply default values to config
   */
  protected withDefaults(config: ProviderConfig): Required<Pick<ProviderConfig, 'temperature' | 'maxTokens'>> & ProviderConfig {
    return {
      ...config,
      temperature: config.temperature ?? 1,
      maxTokens: config.maxTokens ?? 4096,
    };
  }
}

/**
 * Provider registry for dynamic provider loading
 */
const providerRegistry = new Map<string, () => Provider>();

export function registerProvider(name: string, factory: () => Provider): void {
  providerRegistry.set(name, factory);
}

export function getProvider(name: string): Provider {
  const factory = providerRegistry.get(name);
  if (!factory) {
    throw new Error(`Provider "${name}" not found. Available: ${Array.from(providerRegistry.keys()).join(', ')}`);
  }
  return factory();
}

export function getAvailableProviders(): string[] {
  return Array.from(providerRegistry.keys());
}
