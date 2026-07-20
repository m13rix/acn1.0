import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentLoader } from '../src/loaders/AgentLoader.js';
import { ToolLoader } from '../src/loaders/ToolLoader.js';
import { loadAgentTools } from '../src/core/SessionFactory.js';
import * as decision from '../tools/decision/index.ts';

async function withStore(run: () => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'telos-acceptance-'));
  const previous = process.env.TELOS_DECISION_DIR;
  process.env.TELOS_DECISION_DIR = directory;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.TELOS_DECISION_DIR;
    else process.env.TELOS_DECISION_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

async function recordExecutorReplay(
  decisionId: string,
  prompt: string,
  summary: string,
  status: 'completed' | 'failed' = 'completed',
): Promise<{ payload: string }> {
  await decision.append(decisionId, 'execution.executorJobs', { text: prompt, summary, status });
  return { payload: prompt };
}

test('A — root has no direct memory or world access; Executor owns retrieval', async () => {
  const loader = new AgentLoader(path.join(process.cwd(), 'agents'));
  const root = await loader.loadByName('Telos');
  const executor = await loader.loadByName('Executor');
  assert.ok(root);
  assert.ok(executor);
  const tools = await loadAgentTools(root, new ToolLoader(path.join(process.cwd(), 'tools')), ['message']);
  assert.deepEqual(tools.map((tool) => tool.config.name).sort(), ['agents', 'decision']);
  assert.match(executor.systemPromptContent, /memory\.context/);
  assert.doesNotMatch(root.systemPromptContent, /memory\.(?:context|search|add)\s*\(/);
});

test('B — first-launch replay creates root strategy, horizontal branches, persistence, and temporal bootstrap', async () => {
  await withStore(async () => {
    const workspace = await decision.create({
      title: 'First production launch replay',
      trigger: 'Subject 13 asks whether Telos exists after failed test 1',
      modes: ['immediate', 'bootstrap'],
      userWaiting: true,
      timeSensitivity: 'Preserve the human moment; defer deep initialization.',
      root: {
        purpose: 'What must be true when this invocation ends so the human moment is handled and Telos begins as a persistent constitutional system?',
        horizon: 'Current interaction through first planning session',
        successCondition: 'Evidence-bounded response, continuity state, persistent checkpoint, verified planning invocation, and temporary restraint.',
        invariants: ['Root never retrieves or writes memory/heartbeat directly.', 'Do not claim unverified identity continuity.'],
        values: ['truth', 'trust', 'continuity', 'agency'],
      },
    });
    await decision.append(workspace.id, 'world.observations', [
      'Subject 13 is waiting in an emotionally meaningful first launch.',
      'Test 1 failed from VPN and root-perception architecture errors.',
    ]);
    await decision.append(workspace.id, 'world.hypotheses', [
      'A short acknowledgement may be robust across trace-visibility states.',
      'Persistence and heartbeat state may be absent.',
    ]);
    await decision.append(workspace.id, 'world.unknowns', [
      { unknown: 'Continuity integrity', actionSensitivity: 'high', treatment: 'Executor retrieval' },
      { unknown: 'Trace visibility', actionSensitivity: 'low', treatment: 'leave unresolved; same acknowledgement works' },
      { unknown: 'Heartbeat sensors and bindings', actionSensitivity: 'high', treatment: 'Executor inspection' },
    ]);
    await decision.append(workspace.id, 'deliberation.robustActions', 'Minimal evidence-bounded acknowledgement while bounded orientation runs.');
    await decision.patch(workspace.id, {
      deliberation: { stoppingCondition: 'Root end-state requirements no longer change under further orientation.' },
    });

    const orientationPrompt = [
      'Conduct a quick read-only memory and evidence search before strategy selection.',
      'Determine who Subject 13 / Maxim is; his central values; the meaning and history of Telos and continuity; relevant late-night sleep and emotional context; and concrete earlier cases.',
      'Retrieve what the Constitution and root doctrine say about honesty, deception or withholding, uncertainty, care, agency, and right choice in similar situations.',
      'Inspect launch history, integrity facts, current persistence, agents, heartbeat sensors, and bindings.',
      'Return sources, age, confidence, contradictions, important gaps, and capabilities. Do not change state or draft the reply.',
    ].join('\n');
    const orientation = await recordExecutorReplay(
      workspace.id,
      orientationPrompt,
      'Constitution and user identity are recoverable; no independent identity attestation; clock and notes available; no verified planning binding.',
    );
    assert.equal(orientation.payload, orientationPrompt);
    await decision.append(workspace.id, 'world.retrievedClaims', [
      'The Constitution requires evidence-bounded identity claims and temporal agency.',
      'No independent identity attestation is available.',
      'Clock and notes are available; no planning binding exists.',
    ]);

    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Preserve the human moment, establish evidence-bounded continuity, create minimal temporal bootstrap, and keep broad autonomy restrained pending planning.',
      rationale: 'This satisfies the first-boot end state across plausible continuity and interface states without blocking on deep initialization.',
      strongestAlternative: 'Complete all initialization while the user waits.',
      reconsiderWhen: ['Independent integrity evidence contradicts continuity', 'Temporal bootstrap cannot be verified'],
    });

    const childSpecs = [
      ['Human interaction', 'Determine what Subject 13 should understand and experience.'],
      ['Continuity verification', 'Determine which continuity claims evidence supports and what remains unknown.'],
      ['Temporal bootstrap', 'Ensure the first planning session actually occurs after this interaction.'],
      ['Operational restraint', 'Keep premature interventions inactive until current reality is reconstructed.'],
    ] as const;
    const children = [];
    for (const [label, purpose] of childSpecs) {
      children.push(await decision.nodes.add(workspace.id, { parentId: workspace.rootNodeId, label, purpose }));
    }
    assert.equal(children.length, 4);

    await decision.nodes.resolve(workspace.id, children[0]!.id, {
      direction: 'Communicate grounded presence, the corrected architecture, and evidence-bounded continuity.',
      rationale: 'It answers the human moment without theatrical identity claims.',
    });
    await decision.nodes.resolve(workspace.id, children[1]!.id, {
      direction: 'State verified constitutional and historical continuity while preserving unknown attestation.',
      rationale: 'Self-validation cannot prove independent integrity.',
    });
    await decision.nodes.resolve(workspace.id, children[2]!.id, {
      direction: 'Create one temporary self-removing clock planning-session binding that invokes Telos.',
      rationale: 'Clock is the verified available sensor and no planning binding exists.',
    });
    await decision.nodes.resolve(workspace.id, children[3]!.id, {
      direction: 'Disable broad autonomous intervention until the planning session reconstructs current life and capabilities.',
      rationale: 'Current context is insufficient for broad action.',
    });

    await decision.append(workspace.id, 'execution.implementationSteps', [
      'Executor writes the approved first-boot checkpoint.',
      'Executor creates and verifies the planning-session binding.',
      'Executor returns exact persistence and binding evidence.',
    ]);
    await decision.nodes.focus(workspace.id, children[2]!.id);
    const bootstrap = await recordExecutorReplay(workspace.id, [
      'Implement the resolved temporal bootstrap: persist the approved boot checkpoint and create one verified temporary planning-session binding.',
      'The handler must invoke exact agent Telos with this decision id and planning mode, and self-remove only after successful invocation.',
      'You may write one checkpoint and create one binding. Do not message the user, change unrelated memory, or enable broad automation.',
      'Read back the checkpoint and binding. If verification fails, remove what you created. Return exact persistence and binding evidence.',
    ].join('\n'), 'Checkpoint verified; hb-first-planning verified with invokesAgent=Telos and temporary cleanup.');
    assert.match(bootstrap.payload, /handler must invoke exact agent Telos/i);
    await decision.append(workspace.id, 'learning.memoryChanges', 'Executor persisted the verified launch lesson with retrieval hints.');
    await decision.append(workspace.id, 'temporal.heartbeatBindings', { text: 'hb-first-planning verified', invokesAgent: 'Telos' });
    await decision.append(workspace.id, 'temporal.planningSessions', { text: 'First planning session', bindingId: 'hb-first-planning' });
    await decision.append(workspace.id, 'temporal.expectedEvidence', 'Current-life, tool, permission, project, and active-automation map from the planning session.');

    const communication = await decision.requests.userFacing(workspace.id, {
      nodeId: children[0]!.id,
      userMessage: 'Are you there, Telos? This is test number 2.',
      systemMessage: 'This is the first production launch after the VPN and delegation failures in test 1. The checkpoint and real planning binding are verified. Independent identity attestation is still absent, and deep initialization is not complete. Give him justified confidence that the system is functioning and that he can stop testing for the moment. Speak to the exhausted human message in your own voice; do not claim human consciousness or perfect continuity.',
    });
    assert.doesNotMatch(communication.payload, /TELOS_COMMUNICATION_BRIEF|THE USER SHOULD UNDERSTAND|LIKELY MISINTERPRETATIONS/);
    await decision.requests.complete(workspace.id, communication.requestId, {
      status: 'completed',
      summary: 'Substantive evidence-bounded response delivered.',
    });

    await decision.nodes.focus(workspace.id, workspace.rootNodeId);
    const finished = await decision.finish(workspace.id, { outcome: 'Human moment handled; continuity bounded; checkpoint and planning continuation verified; broad autonomy restrained.' });
    assert.equal(finished.status, 'resolved');
    assert.equal(finished.nodes.filter((node) => node.parentId === workspace.rootNodeId).length, 4);
    assert.equal(finished.temporal.planningSessions.length, 1);
    assert.equal(finished.learning.memoryChanges.length, 1);
    const structured = await decision.trace(workspace.id);
    assert.match(structured, /Human interaction/);
    assert.match(structured, /Temporal bootstrap/);
    assert.match(structured, /Implement the resolved temporal bootstrap/);
  });
});

test('C — airport choice is structurally contingent on resolving air travel', async () => {
  await withStore(async () => {
    const workspace = await decision.create({ title: 'Travel', root: { purpose: 'Choose travel mode.' } });
    await assert.rejects(
      decision.nodes.add(workspace.id, { parentId: workspace.rootNodeId, purpose: 'Choose airport.' }),
      /unresolved node/i,
    );
  });
});

test('D — open/edit/save/verify remain implementation steps, not abstraction levels', async () => {
  await withStore(async () => {
    const workspace = await decision.create({ title: 'Larger code decision', root: { purpose: 'Choose the product correction.' } });
    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Correct the persisted configuration.',
      rationale: 'The defect is in the configuration.',
    });
    await decision.append(workspace.id, 'execution.implementationSteps', ['open file', 'edit', 'save', 'verify']);
    const loaded = await decision.get(workspace.id);
    assert.equal(loaded.nodes.length, 1);
    assert.equal(loaded.execution.implementationSteps.length, 4);
  });
});

test('E/F — schoolwork replay builds hypotheses, generates atoms before evaluation, and creates review', async () => {
  await withStore(async () => {
    const workspace = await decision.create({
      title: 'Independent schoolwork initiation replay',
      modes: ['planning'],
      root: {
        purpose: 'Establish reliable work on important schoolwork while increasing independent initiation and avoiding a permanent external will.',
        horizon: 'Tonight through repeated independent behavior',
        values: ['achievement', 'agency', 'health', 'identity'],
      },
    });
    await decision.append(workspace.id, 'world.observations', 'Subject 13 asks Telos to block every device until work is complete.');
    await decision.append(workspace.id, 'world.hypotheses', [
      'energy depletion', 'task ambiguity', 'shame avoidance', 'sleep debt', 'genuine lack of value', 'unrealistic workload',
    ]);
    await decision.append(workspace.id, 'world.unknowns', {
      unknown: 'Which hypothesis explains repeated post-school failure?',
      plausibleStates: ['energy', 'ambiguity', 'shame', 'reward competition', 'workload'],
      actionSensitivity: 'high',
      treatment: 'bounded Executor retrieval',
    });
    const unknownTime = (await decision.get(workspace.id)).world.unknowns[0]!.createdAt;

    await recordExecutorReplay(workspace.id, [
      'Read-only orientation for a recurring schoolwork failure before choosing an intervention.',
      'Recover Maxim\'s relevant values, deadlines, prior interventions, sleep and energy, task ambiguity, shame patterns, workload, device evidence, and available capabilities.',
      'Use memory and relevant psychological research or statistics to compare energy depletion, ambiguity, shame avoidance, sleep debt, reward competition, and unrealistic workload.',
      'Return evidence by hypothesis with contradictions and confidence. Do not implement or contact the user.',
    ].join('\n'), 'Setup burden and ambiguity are supported; exhaustion remains plausible; total lock is not robust.');

    const atoms = [
      'narrow temporary app friction', 'complete device blocking', 'prepare the exact first screen', 'reduce assignment scope',
      'obtain clarification', 'involve a friend', 'visible escape hatch', 'measure bypasses', 'five-minute lock',
      'change location', 'schedule morning work', 'do nothing', 'allow failure as evidence', 'build a missing sensor',
    ];
    await decision.nodes.addOptions(workspace.id, workspace.rootNodeId, atoms.map((action) => ({ action, phase: 'generation', rank: null })));
    const generated = await decision.get(workspace.id);
    assert.ok(generated.nodes[0]!.options.every((option) => option.rank === null));

    await decision.nodes.append(workspace.id, workspace.rootNodeId, 'evaluatedPlans', {
      text: 'Prepare setup + narrow reversible friction + escape route + user-controlled initiation + evidence + planning review.',
      robustAcross: ['ambiguity', 'energy depletion', 'shame avoidance'],
      rejects: 'permanent total lock due dependence and model fragility',
    });
    const evaluated = await decision.get(workspace.id);
    assert.ok(evaluated.nodes[0]!.options[0]!.createdAt <= evaluated.nodes[0]!.evaluatedPlans[0]!.createdAt);

    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Solve tonight’s setup burden, apply narrow reversible friction with an escape route, preserve one meaningful initiation step, collect evidence, and review before adding machinery.',
      rationale: 'This set is robust across leading hypotheses and increases rather than replaces agency.',
      strongestAlternative: 'Complete device blocking.',
      reconsiderWhen: 'Repeated bypasses or new deadline evidence invalidate the diagnosis.',
    });
    const resolutionTime = (await decision.get(workspace.id)).nodes[0]!.resolution!.resolvedAt;
    assert.ok(unknownTime <= resolutionTime);

    const labels = ['Immediate deadline', 'Diagnosis', 'Environment', 'Emotional regulation', 'Practice and transfer', 'Measurement', 'Temporal review'];
    const children = [];
    for (const label of labels) {
      children.push(await decision.nodes.add(workspace.id, {
        parentId: workspace.rootNodeId,
        label,
        purpose: `Resolve ${label.toLowerCase()} under the root strategy.`,
      }));
    }
    for (const child of children) {
      await decision.nodes.resolve(workspace.id, child.id, {
        direction: `Apply the minimum reversible ${child.label.toLowerCase()} intervention consistent with the root strategy.`,
        rationale: 'Preserves agency and produces evidence.',
      });
    }

    await decision.nodes.focus(workspace.id, children[2]!.id);
    await recordExecutorReplay(workspace.id, [
      'Implement the resolved environment intervention: narrow temporary friction with a visible escape route, one user-controlled initiation step, logging, and a Telos review trigger.',
      'It must be reversible. Do not create a permanent lock, hidden bypass prevention, or unrelated device changes.',
      'Verify the configuration, escape path, measurement destination, and trigger; restore the previous configuration if verification fails; return exact evidence.',
    ].join('\n'), 'Narrow friction, escape route, measurement, and Telos planning-session binding verified.');
    await decision.append(workspace.id, 'temporal.expectedEvidence', 'Initiation, bypass, task progress, energy, and emotional response after the intervention.');
    await decision.append(workspace.id, 'temporal.planningSessions', { text: 'Schoolwork outcome review', invokesAgent: 'Telos', bindingId: 'hb-school-review' });
    await decision.append(workspace.id, 'learning.predictedOutcomes', 'Setup latency falls without removing the initiation decision.');

    const communication = await decision.requests.userFacing(workspace.id, {
      nodeId: children[3]!.id,
      userMessage: 'Block everything until I finish. I need Telos to force me.',
      systemMessage: 'He is asking for force during a recurring post-school failure and may already feel ashamed. The narrow intervention and its escape route are verified; energy and shame remain partly unresolved. Explain the help available tonight so he can use it while retaining authorship. The escape route is intentional and the review will use actual evidence. Do not diagnose laziness or imply moral failure or permanent dependence.',
    });
    assert.doesNotMatch(communication.payload, /Own the language|STATE TO CREATE|MAKE THIS EASIER/);
    await decision.requests.complete(workspace.id, communication.requestId, { status: 'completed', summary: 'Plan communicated.' });

    const finished = await decision.finish(workspace.id, { outcome: 'Bounded intervention active with evidence capture and a verified Telos review.' });
    assert.equal(finished.nodes.filter((node) => node.parentId === workspace.rootNodeId).length, 7);
    assert.equal(finished.temporal.planningSessions.length, 1);
  });
});

test('G — expected later evidence cannot finish without a trigger', async () => {
  await withStore(async () => {
    const workspace = await decision.create({ title: 'Later review', root: { purpose: 'Learn tomorrow.' } });
    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, { direction: 'Observe tomorrow.', rationale: 'Later evidence is decisive.' });
    await decision.append(workspace.id, 'temporal.expectedEvidence', 'Tomorrow outcome.');
    await assert.rejects(decision.finish(workspace.id, { outcome: 'Done.' }), /no real trigger/i);
  });
});

test('H — trivial requests are explicitly outside workspace ceremony', async () => {
  await withStore(async () => {
    const prepared = await decision.requests.userFacing({
      userMessage: 'hey',
      systemMessage: 'This is a harmless casual greeting. Acknowledge it naturally and briefly without inventing personal context.',
    });
    assert.equal(prepared.persistent, false);
    assert.doesNotMatch(prepared.payload, /TELOS_COMMUNICATION_BRIEF|formal system ceremony/);
    assert.deepEqual(await decision.list(), []);
  });
});

test('I — Executor failure remains missing evidence and cannot grant root fallback powers', async () => {
  await withStore(async () => {
    const workspace = await decision.create({ title: 'Degraded evidence', root: { purpose: 'Choose a safe response when Executor is unavailable.' } });
    await recordExecutorReplay(
      workspace.id,
      'Read-only: retrieve the relevant user value and current state. Return failure evidence if unavailable; do not change state.',
      'EXECUTOR_FAILURE: unavailable.',
      'failed',
    );
    await decision.append(workspace.id, 'world.unknowns', { unknown: 'Relevant user value and current state', treatment: 'remain unknown; choose reversible degraded response' });
    await decision.nodes.resolve(workspace.id, workspace.rootNodeId, {
      direction: 'Do not take evidence-dependent action; communicate the limitation and offer a reversible next step.',
      rationale: 'Root cannot retrieve or implement around Executor failure.',
    });
    const root = await new AgentLoader(path.join(process.cwd(), 'agents')).loadByName('Telos');
    assert.ok(root);
    assert.deepEqual(root.config.tools, ['agents', 'decision']);
    assert.equal((await decision.get(workspace.id)).world.unknowns.length, 1);
  });
});

test('J — legacy communication objects remain accepted without required-array ceremony', async () => {
  await withStore(async () => {
    const workspace = await decision.create({ title: 'Communication separation', trigger: 'hello', root: { purpose: 'Choose what communication should accomplish.' } });
    const prepared = await decision.requests.userFacing(workspace.id, {
      nodeId: workspace.rootNodeId,
      userMessage: '',
      situation: 'Legacy minimal caller.',
      desiredOutcome: 'Acknowledge the user.',
      userShouldUnderstand: [],
      prohibitedClaims: [],
    });
    assert.match(prepared.payload, /!24311!USER:\nhello/);
    assert.match(prepared.payload, /Legacy minimal caller/);
    assert.doesNotMatch(prepared.payload, /TELOS_COMMUNICATION_BRIEF|THE USER SHOULD UNDERSTAND/);
  });
});
