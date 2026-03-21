import test from 'node:test';
import assert from 'node:assert/strict';
import { resetSandboxCallQueueForTests, runInSandboxCallQueue } from '../AgentCallQueue.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('serializes calls for the same sandbox and marks waited calls', async () => {
  resetSandboxCallQueueForTests();
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = () => resolve();
  });

  const first = runInSandboxCallQueue('sandbox-a', async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
    return 'first-result';
  });

  await sleep(20);

  const second = runInSandboxCallQueue('sandbox-a', async () => {
    order.push('second-start');
    order.push('second-end');
    return 'second-result';
  });

  await sleep(20);
  assert.deepEqual(order, ['first-start']);

  if (releaseFirst) {
    releaseFirst();
  }
  const firstResult = await first;
  const secondResult = await second;

  assert.equal(firstResult.waited, false);
  assert.equal(firstResult.value, 'first-result');
  assert.equal(secondResult.waited, true);
  assert.equal(secondResult.value, 'second-result');
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('does not serialize different sandbox queues together', async () => {
  resetSandboxCallQueueForTests();
  let releaseA: (() => void) | undefined;
  const gateA = new Promise<void>(resolve => {
    releaseA = () => resolve();
  });

  const callA = runInSandboxCallQueue('sandbox-a', async () => {
    await gateA;
    return 'a';
  });

  await sleep(20);

  const callB = await runInSandboxCallQueue('sandbox-b', async () => 'b');
  assert.equal(callB.waited, false);
  assert.equal(callB.value, 'b');

  if (releaseA) {
    releaseA();
  }
  const resultA = await callA;
  assert.equal(resultA.waited, false);
  assert.equal(resultA.value, 'a');
});
