import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanningSessionHandler } from '../tools/heartbeat/planning-session.ts';

test('planning-session heartbeat invokes exact root Telos and self-removes after success', async () => {
  const calls: Array<{ agent: string; request: string }> = [];
  let unbound = false;
  const previous = (globalThis as any).agents;
  (globalThis as any).agents = {
    run: async (agent: string, request: string) => {
      calls.push({ agent, request });
      return { jobName: 'planning', finalMessage: 'root planning completed' };
    },
  };
  try {
    const handler = buildPlanningSessionHandler('decision-123', 'Reconstruct current life.', true) as any;
    await handler(
      { sensor: 'clock', event: 'at', args: ['09:00'], payload: {}, occurredAt: '2026-07-19T06:00:00Z', bindingId: 'hb-plan' },
      { unbind: async () => { unbound = true; } },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.agent, 'Telos');
    assert.match(calls[0]!.request, /TELOS_PLANNING_SESSION v1/);
    assert.match(calls[0]!.request, /MODE: PLANNING/);
    assert.match(calls[0]!.request, /DECISION_ID: decision-123/);
    assert.equal(unbound, true);
  } finally {
    if (previous === undefined) delete (globalThis as any).agents;
    else (globalThis as any).agents = previous;
  }
});

test('temporary planning binding remains installed when root invocation fails', async () => {
  let unbound = false;
  const previous = (globalThis as any).agents;
  (globalThis as any).agents = {
    run: async () => ({ jobName: 'planning', finalMessage: 'Error: root unavailable' }),
  };
  try {
    const handler = buildPlanningSessionHandler('decision-123', 'Reconstruct current life.', true) as any;
    await assert.rejects(
      handler(
        { sensor: 'clock', event: 'at', args: [], payload: {}, occurredAt: '2026-07-19T06:00:00Z', bindingId: 'hb-plan' },
        { unbind: async () => { unbound = true; } },
      ),
      /Telos invocation failed/i,
    );
    assert.equal(unbound, false);
  } finally {
    if (previous === undefined) delete (globalThis as any).agents;
    else (globalThis as any).agents = previous;
  }
});
