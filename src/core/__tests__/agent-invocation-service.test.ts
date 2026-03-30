import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentInvocationService } from '../AgentInvocationService.js';
import type { LoadedAgent } from '../../types/index.js';

const voiceAgent: LoadedAgent = {
  config: {
    name: 'voice-agent',
    model: 'gemini-3.1-flash-live-preview',
    provider: 'gemini-voice',
    modality: 'voice',
    interface: 'local-voice',
    systemPrompt: 'prompts/system.md',
    tools: [],
    loop: 'provider-tools',
    syntax: 'markdown',
  },
  systemPromptContent: 'You are a voice assistant.',
  directory: '/tmp/voice-agent',
};

test('voice agents reject telegram interface override', async () => {
  const service = new AgentInvocationService({
    loadByName: async () => voiceAgent,
    getAvailableAgents: async () => ['voice-agent'],
    loadAll: async () => [voiceAgent],
  } as any);

  await assert.rejects(
    () => service.callAgent({
      agent: 'voice-agent',
      message: 'hello',
      interface: 'telegram',
      sandbox: {
        directory: process.cwd(),
      } as any,
    }),
    /cannot be invoked through interface "telegram"/i
  );
});
