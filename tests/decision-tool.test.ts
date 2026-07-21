import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as decision from '../tools/decision/index.ts';

async function withDecisionStore(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'telos-decision-'));
  const previous = process.env.TELOS_DECISION_DIR;
  process.env.TELOS_DECISION_DIR = directory;
  try {
    await run(directory);
  } finally {
    if (previous === undefined) delete process.env.TELOS_DECISION_DIR;
    else process.env.TELOS_DECISION_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('persists horizontal branches, vertical descent, options, and resolution', async () => {
  await withDecisionStore(async (directory) => {
    const workspace = await decision.create({
      title: 'First production activation',
      trigger: 'First user message',
      modes: ['immediate', 'bootstrap'],
      userWaiting: true,
      root: {
        purpose: 'Preserve the human moment and establish operational continuity.',
        invariants: ['Do not claim unverified continuity.'],
        values: ['truth', 'trust', 'agency'],
      },
    });

    await decision.append(workspace.id, 'world.observations', 'The user is visibly waiting.');
    await decision.append(workspace.id, 'world.unknowns', {
      unknown: 'Whether a planning heartbeat exists',
      actionSensitivity: 'high',
      treatment: 'ask Executor to inspect without side effects',
    });

    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Preserve the human moment and establish operational continuity.',
      rationale: 'This is robust across plausible first-launch states.',
    });

    const human = await decision.nodes.add(workspace.id, {
      parentId: workspace.rootNodeId,
      label: 'Human interaction',
      purpose: 'Choose the communicative outcome.',
    });
    const temporal = await decision.nodes.add(workspace.id, {
      parentId: workspace.rootNodeId,
      label: 'Temporal bootstrap',
      purpose: 'Ensure Telos returns for planning.',
    });
    await decision.nodes.resolve(workspace.id, temporal.id, {
      direction: 'Create a verified future planning invocation.',
      rationale: 'Deep initialization should not block the waiting interaction.',
    });
    const trigger = await decision.nodes.add(workspace.id, {
      parentId: temporal.id,
      label: 'Trigger mechanism',
      purpose: 'Choose an executable wake condition.',
      parentConstraint: 'A planning session must occur after the user-facing response.',
    });

    await decision.nodes.addOptions(workspace.id, trigger.id, [
      { action: 'Trigger on return-to-activity', kind: 'event' },
      { action: 'Use a temporary clock heartbeat', kind: 'time' },
    ]);
    await decision.nodes.resolve(workspace.id, trigger.id, {
      direction: 'Use a temporary clock heartbeat.',
      rationale: 'Activity sensing is unavailable in the current capability map.',
      strongestAlternative: 'Return-to-activity trigger',
      reconsiderWhen: 'An activity sensor becomes available.',
    });

    const loaded = await decision.get(workspace.id);
    assert.equal(loaded.nodes.length, 4);
    assert.equal(loaded.nodes.filter((node) => node.parentId === workspace.rootNodeId).length, 2);
    assert.equal(loaded.nodes.find((node) => node.id === trigger.id)?.options.length, 2);
    assert.equal(loaded.nodes.find((node) => node.id === trigger.id)?.resolution?.strongestAlternative, 'Return-to-activity trigger');
    assert.equal(loaded.world.unknowns[0]?.actionSensitivity, 'high');

    const compact = await decision.summary(workspace.id);
    assert.equal(compact.nodes.find((node) => node.id === human.id)?.depth, 1);
    assert.equal(compact.nodes.find((node) => node.id === trigger.id)?.depth, 2);

    const stored = JSON.parse(await readFile(path.join(directory, `${workspace.id}.json`), 'utf8'));
    assert.equal(stored.id, workspace.id);
  });
});

test('serializes concurrent updates without losing entries', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({
      title: 'Concurrent evidence',
      root: { purpose: 'Preserve every independent observation.' },
    });

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      decision.append(workspace.id, 'world.observations', `observation ${index}`)));

    const loaded = await decision.get(workspace.id);
    assert.equal(loaded.world.observations.length, 20);
    assert.equal(new Set(loaded.world.observations.map((entry) => entry.text)).size, 20);
  });
});

test('protects tree identity and requires explicit recursive branch removal', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({
      title: 'Tree integrity',
      root: { purpose: 'Keep the decision hierarchy coherent.' },
    });
    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Preserve dependent decision structure.',
      rationale: 'Children must inherit a resolved parent constraint.',
    });
    const branch = await decision.nodes.add(workspace.id, {
      parentId: workspace.rootNodeId,
      purpose: 'Resolve a branch.',
    });
    await decision.nodes.resolve(workspace.id, branch.id, {
      direction: 'Resolve this branch before descending.',
      rationale: 'The lower space depends on this choice.',
    });
    await decision.nodes.add(workspace.id, {
      parentId: branch.id,
      purpose: 'Resolve a dependent child.',
    });

    await assert.rejects(
      decision.nodes.patch(workspace.id, branch.id, { parentId: 'elsewhere' }),
      /cannot change parentId/,
    );
    await assert.rejects(decision.nodes.remove(workspace.id, branch.id), /has children/);
    await decision.nodes.remove(workspace.id, branch.id, { recursive: true });
    assert.equal((await decision.get(workspace.id)).nodes.length, 1);
  });
});

test('normalizes replacement patches instead of allowing schema corruption', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({
      title: 'Patch safety',
      modes: ['planning'],
      root: { purpose: 'Keep flexible state structurally reliable.' },
    });

    await decision.patch(workspace.id, {
      modes: ['planning', 'planning', 'bootstrap'],
      world: {
        observations: ['An observation replaced the previous set.'],
      },
      deliberation: {
        stoppingCondition: 'The next action is robust.',
      },
    });
    await decision.nodes.patch(workspace.id, workspace.rootNodeId, {
      options: [{ action: 'Run a reversible experiment', kind: 'experiment' }],
    });

    const loaded = await decision.get(workspace.id);
    assert.deepEqual(loaded.modes, ['planning', 'bootstrap']);
    assert.equal(loaded.world.observations[0]?.text, 'An observation replaced the previous set.');
    assert.equal(loaded.nodes[0]?.options[0]?.text, 'Run a reversible experiment');
    assert.equal(loaded.deliberation.stoppingCondition, 'The next action is robust.');

    await assert.rejects(decision.patch(workspace.id, { nodes: [] }), /cannot change nodes/);
    await assert.rejects(decision.nodes.patch(workspace.id, workspace.rootNodeId, { resolution: {} }), /cannot change resolution/);
  });
});

test('a lower abstraction cannot exist until its parent direction is resolved', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({
      title: 'Travel choice',
      root: { purpose: 'Choose how to reach the destination.' },
    });

    await assert.rejects(
      decision.nodes.add(workspace.id, {
        parentId: workspace.rootNodeId,
        label: 'Airport',
        purpose: 'Choose an airport.',
      }),
      /Resolve the parent direction first/i,
    );

    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Travel by plane.',
      rationale: 'Only air travel satisfies the time constraint.',
    });
    const airport = await decision.nodes.add(workspace.id, {
      parentId: workspace.rootNodeId,
      label: 'Airport',
      purpose: 'Choose an airport.',
    });
    assert.equal(airport.parentConstraint, 'Travel by plane.');
  });
});

test('records a plain Executor delegation as ordinary decision state and renders structured trace', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({
      title: 'First launch',
      modes: ['immediate', 'bootstrap'],
      userWaiting: true,
      root: { purpose: 'Determine what must be true when the first invocation ends.' },
    });
    await decision.append(workspace.id, 'world.observations', 'The user is waiting.');
    await decision.append(workspace.id, 'world.hypotheses', 'Continuity evidence may be incomplete.');

    const prompt = 'Read-only: recover Maxim\'s values, relevant Constitution sections, launch history, and heartbeat state. Return sourced contradictions and uncertainty; do not change state or draft a reply.';
    await decision.append(workspace.id, 'execution.executorJobs', {
      text: prompt,
      status: 'completed',
      summary: 'Persistence state is unknown; heartbeat inspection is still required.',
    });

    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Preserve the human moment, verify continuity, and create temporal bootstrap.',
      rationale: 'This remains robust across the plausible launch states.',
      reconsiderWhen: 'Verified continuity evidence contradicts the current model.',
    });
    const human = await decision.nodes.add(workspace.id, {
      parentId: workspace.rootNodeId,
      label: 'Human interaction',
      purpose: 'Choose what the interaction should make the user understand.',
    });

    const communication = await decision.requests.userFacing(workspace.id, {
      nodeId: human.id,
      userMessage: 'Are you there, Telos?',
      systemMessage: 'This is the first production launch and he is waiting. Executor completed the scoped orientation, but identity integrity is not independently attested. Let him know Telos is functioning without claiming human consciousness or complete continuity. Respond to his actual words in your own voice.',
    });
    assert.equal(communication.agent, 'user-facing');
    assert.match(communication.payload, /!24311!USER:/);
    assert.match(communication.payload, /!24311!SYSTEM:/);
    assert.doesNotMatch(communication.payload, /TELOS_COMMUNICATION_BRIEF|THE USER SHOULD UNDERSTAND|TONE \/ LENGTH/);

    const legacy = await decision.requests.userFacing(workspace.id, {
      nodeId: human.id,
      userMessage: 'hello',
      situation: 'A legacy caller supplied only a minimal brief.',
      desiredOutcome: 'Acknowledge the greeting.',
      userShouldUnderstand: [],
      prohibitedClaims: [],
    });
    assert.match(legacy.payload, /A legacy caller supplied only a minimal brief/);
    assert.doesNotMatch(legacy.payload, /TELOS_COMMUNICATION_BRIEF|THE USER SHOULD UNDERSTAND/);
    await decision.requests.complete(workspace.id, communication.requestId, {
      status: 'delivered',
      summary: 'The user-facing agent delivered the response.',
    });

    const rendered = await decision.trace(workspace.id);
    assert.match(rendered, /MODE\nimmediate \+ bootstrap/);
    assert.match(rendered, /ROOT QUESTION/);
    assert.match(rendered, /CURRENT NODE\nHuman interaction/);
    assert.match(rendered, /DELEGATED JOBS/);
    assert.doesNotMatch(rendered, /Hmm|maybe one message/i);
  });
});

test('future evidence prevents completion until a real continuation is recorded', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({
      title: 'Tomorrow evidence',
      root: { purpose: 'Run an intervention and learn from tomorrow evidence.' },
    });
    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Run the reversible intervention and inspect the outcome tomorrow.',
      rationale: 'The intervention is informative and low-risk.',
    });
    await decision.append(workspace.id, 'temporal.expectedEvidence', 'Whether initiation happened without bypassing.');

    await assert.rejects(
      decision.finish(workspace.id, { outcome: 'Intervention launched.' }),
      /no real trigger/i,
    );

    await decision.append(workspace.id, 'temporal.planningSessions', {
      text: 'Verified planning-session heartbeat',
      bindingId: 'hb-review',
      invokesAgent: 'Telos',
    });
    const finished = await decision.finish(workspace.id, { outcome: 'Intervention launched with verified review.' });
    assert.equal(finished.status, 'resolved');
  });
});

test('evaluation cannot precede generation and parent reconsideration invalidates descendants explicitly', async () => {
  await withDecisionStore(async () => {
    const workspace = await decision.create({ title: 'Reconsideration', root: { purpose: 'Choose a strategy.' } });
    await assert.rejects(
      decision.nodes.append(workspace.id, workspace.rootNodeId, 'evaluatedPlans', 'Preferred plan'),
      /generated options first/i,
    );
    await decision.nodes.addOptions(workspace.id, workspace.rootNodeId, ['Option A', 'Option B']);
    await decision.nodes.append(workspace.id, workspace.rootNodeId, 'evaluatedPlans', 'Option A is more robust.');
    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, { direction: 'Choose A.', rationale: 'More robust.' });
    await decision.nodes.add(workspace.id, { parentId: workspace.rootNodeId, purpose: 'Resolve the A-specific lower decision.' });

    await assert.rejects(
      decision.nodes.resolve(workspace.id, workspace.rootNodeId, { direction: 'Choose B.', rationale: 'New evidence.' }),
      /dependent children exist/i,
    );
    await assert.rejects(
      decision.nodes.reopen(workspace.id, workspace.rootNodeId, { reason: 'New evidence favors B.' }),
      /removeDescendants: true/i,
    );
    const reopened = await decision.nodes.reopen(workspace.id, workspace.rootNodeId, {
      reason: 'New evidence favors B.',
      removeDescendants: true,
    });
    assert.equal(reopened.resolution, undefined);
    assert.equal((await decision.get(workspace.id)).nodes.length, 1);
  });
});
