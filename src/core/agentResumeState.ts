import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

import type { SessionSnapshot } from './Session.js';
import type { AgentInstructionAlgorithmConfig } from '../types/index.js';

export interface AgentResumeDescriptor {
  label: string;
  agent: string;
  extraSystemPrompt?: string;
  modelOverride?: string;
  providerOverride?: string;
  systemPromptOverride?: string;
  instructionAlgorithmOverride?: AgentInstructionAlgorithmConfig | false;
  isSubagent?: boolean;
  interfaceOverride?: string;
}

export interface PersistedAgentSessionState {
  version: 1;
  savedAt: string;
  descriptor: AgentResumeDescriptor;
  snapshot: SessionSnapshot;
}

export async function writePersistedAgentSessionState(
  filePath: string,
  state: PersistedAgentSessionState
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export async function readPersistedAgentSessionState(
  filePath: string
): Promise<PersistedAgentSessionState | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedAgentSessionState>;
    if (parsed?.version !== 1 || !parsed.descriptor || !parsed.snapshot) {
      return null;
    }
    if (typeof parsed.descriptor.agent !== 'string' || typeof parsed.descriptor.label !== 'string') {
      return null;
    }
    return parsed as PersistedAgentSessionState;
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
