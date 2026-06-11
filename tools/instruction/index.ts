import { AgentLoader } from '../../src/loaders/AgentLoader.js';
import { getInstructionAlgorithmService } from '../../src/instruction-algorithm/Service.js';

async function currentAgent() {
  const agentName = (process.env.TELOS_AGENT_NAME || '').trim();
  if (!agentName) {
    throw new Error('instruction tool requires TELOS_AGENT_NAME.');
  }
  const agent = await new AgentLoader().loadByName(agentName);
  if (!agent) {
    throw new Error(`instruction tool could not load agent "${agentName}".`);
  }
  return agent;
}

function sessionId(): string {
  const value = (process.env.TELOS_SESSION_ID || '').trim();
  if (!value) {
    throw new Error('instruction tool requires TELOS_SESSION_ID.');
  }
  return value;
}

function normalizeNextInput(input?: string | { note?: string; step?: string }): { note?: string; step?: string } {
  if (typeof input === 'string') {
    return { note: input };
  }
  if (!input || typeof input !== 'object') {
    return {};
  }
  return {
    note: typeof input.note === 'string' ? input.note : undefined,
    step: typeof input.step === 'string' ? input.step : undefined,
  };
}

function emitInstructionResult<T extends { message?: string }>(view: T): T {
  if (view.message?.trim()) {
    console.log(view.message);
  }
  return view;
}

export async function current() {
  const agent = await currentAgent();
  return emitInstructionResult(getInstructionAlgorithmService().current(agent, sessionId()));
}

export async function next(input?: string | { note?: string; step?: string }) {
  const agent = await currentAgent();
  return emitInstructionResult(getInstructionAlgorithmService().next(agent, sessionId(), normalizeNextInput(input)));
}

export async function set(stepId: string, note?: string) {
  const agent = await currentAgent();
  return emitInstructionResult(getInstructionAlgorithmService().set(agent, sessionId(), stepId, note));
}
