import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { SelfImproverStateService } from '../src/services/self-improver/StateService.ts';

async function makeTempService() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telos-self-improver-'));
  const service = new SelfImproverStateService({ stateDir: tempRoot });

  return {
    service,
    tempRoot,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

test('bootstraps mirrors and summary files', async () => {
  const { service, cleanup } = await makeTempService();

  try {
    const state = await service.getState();

    assert.ok(state.dossierSummary.principles.length > 0);
    assert.equal(state.backlogItems.length, 1);
    assert.equal(state.recentAudits.length, 1);

    await access(service.paths.visionDossierFile);
    await access(service.paths.backlogFile);
    await access(service.paths.auditLogFile);
    await access(service.paths.stateSummaryFile);
    await access(service.paths.retrievalAwarenessFile);
    await access(service.paths.alignmentScorecardFile);

    const summary = await readFile(service.paths.stateSummaryFile, 'utf8');
    assert.match(summary, /State Summary/);
    assert.match(summary, /si-bootstrap-v1/);
    assert.match(summary, /Retrieval awareness queries/);

    const retrievalAwareness = await readFile(service.paths.retrievalAwarenessFile, 'utf8');
    assert.match(retrievalAwareness, /Retrieval Awareness/);
    assert.match(retrievalAwareness, /Boot Queries/);

    const scorecard = await readFile(service.paths.alignmentScorecardFile, 'utf8');
    assert.match(scorecard, /No alignment assessments recorded yet/);

    assert.ok(state.retrievalAwareness.bootQueries.length > 0);
    assert.equal(state.alignment.current, null);
  } finally {
    await cleanup();
  }
});

test('self-origin initiatives stay pending approval while user tasks are immediately approved', async () => {
  const { service, cleanup } = await makeTempService();

  try {
    const selfInitiative = await service.proposeInitiative({
      title: 'Refactor browser extractor',
      summary: 'Investigate a higher quality HTML compaction path.',
      origin: 'self',
      rationale: 'The browser subsystem may benefit from denser DOM context.',
      impact: 'Could improve browser operator accuracy.',
    });

    assert.equal(selfInitiative.status, 'proposed');
    assert.equal(selfInitiative.approval.required, true);
    assert.equal(selfInitiative.approval.state, 'pending');

    const userInitiative = await service.proposeInitiative({
      title: 'Implement internal API smoke harness',
      summary: 'Add a reusable regression harness around the internal API.',
      origin: 'user',
      rationale: 'The user explicitly asked for concrete execution work.',
      impact: 'Makes programmatic regression checks reliable.',
    });

    assert.equal(userInitiative.status, 'approved');
    assert.equal(userInitiative.approval.required, false);
    assert.equal(userInitiative.approval.state, 'not_required');
  } finally {
    await cleanup();
  }
});

test('initiative updates merge blockers, tests, and codex threads', async () => {
  const { service, cleanup } = await makeTempService();

  try {
    const initiative = await service.proposeInitiative({
      title: 'Implement regression harness',
      summary: 'Add a full internal API regression harness.',
      origin: 'user',
      rationale: 'Needed for repeatable verification.',
      impact: 'Improves confidence in future changes.',
    });

    const updated = await service.updateInitiative(initiative.id, {
      status: 'in_progress',
      appendBlockers: ['Need stable server lifecycle wrapper.'],
      appendTestResults: [
        {
          name: 'Internal API ping',
          status: 'passed',
          details: 'Smoke call completed successfully.',
          recordedAt: '2026-04-02T10:00:00.000Z',
        },
      ],
      appendCodexThreads: [
        {
          name: 'SI::implement-regression-harness::impl::server-lifecycle',
          phase: 'impl',
          summary: 'Server lifecycle and API harness work.',
          workingDirectory: './',
          model: 'gpt-5.4',
          modelReasoningEffort: 'medium',
          threadId: 'thread_123',
          linkedAt: '2026-04-02T10:00:00.000Z',
          status: 'running',
        },
      ],
      finalOutcome: 'Implementation started and first smoke test passed.',
    });

    assert.equal(updated.status, 'in_progress');
    assert.deepEqual(updated.blockers, ['Need stable server lifecycle wrapper.']);
    assert.equal(updated.testResults.length, 1);
    assert.equal(updated.testResults[0]?.status, 'passed');
    assert.equal(updated.codexThreads.length, 1);
    assert.equal(updated.codexThreads[0]?.threadId, 'thread_123');
    assert.match(updated.finalOutcome || '', /Implementation started/);
  } finally {
    await cleanup();
  }
});

test('saveInsight persists into the dossier without requiring sync side effects', async () => {
  const { service, cleanup } = await makeTempService();

  try {
    const result = await service.saveInsight({
      title: 'Ask Before Expanding Scope',
      kind: 'constraint',
      content: 'When a new idea changes product scope, get explicit user approval before implementation.',
      syncMemory: false,
    });

    assert.equal(result.sync.length, 0);

    const dossier = await readFile(service.paths.visionDossierFile, 'utf8');
    assert.match(dossier, /Ask Before Expanding Scope/);

    const state = await service.getState();
    assert.ok(state.dossierSummary.constraints.some((item) => item.includes('Ask Before Expanding Scope')));
    assert.ok(
      state.retrievalAwareness.sources.some((source) =>
        source.awarenessTitles.some((title) => title.includes('Ask Before Expanding Scope'))
      )
    );
  } finally {
    await cleanup();
  }
});

test('alignment assessments compute overall score and drift and mirror into the scorecard', async () => {
  const { service, cleanup } = await makeTempService();

  try {
    const first = await service.recordAlignmentAssessment({
      title: 'Interview baseline',
      source: 'test',
      summary: 'Initial explicit assessment after the audit interview.',
      dimensions: [
        { key: 'telos-mission', score: 0.9, rationale: 'Mission fit is explicit.', evidence: ['Mission insight persisted.'] },
        { key: 'quality-execution', score: 0.72, rationale: 'Execution quality is valued but still imperfect.', evidence: ['Reliability issues remain.'] },
        { key: 'retrieval-awareness', score: 0.61, rationale: 'Retrieval awareness was still shallow.', evidence: ['Awareness manifest was missing.'] },
        { key: 'hidden-misalignment', score: 0.84, rationale: 'The failure mode is explicitly recognized.', evidence: ['Hidden misalignment lesson persisted.'] },
        { key: 'approval-trajectory', score: 0.8, rationale: 'Approval rules are explicit and nuanced.', evidence: ['Long-term autonomy target documented.'] },
      ],
    });

    const second = await service.recordAlignmentAssessment({
      title: 'Post-remediation check',
      source: 'test',
      summary: 'Retrieval awareness improved after manifest-driven boot logic was added.',
      dimensions: [
        { key: 'telos-mission', score: 0.92, rationale: 'Mission fit stayed strong.', evidence: ['No drift on core purpose.'] },
        { key: 'quality-execution', score: 0.8, rationale: 'Messaging and sync paths were hardened.', evidence: ['Retry and sanitization work landed.'] },
        { key: 'retrieval-awareness', score: 0.83, rationale: 'Runtime boot now uses awareness manifests.', evidence: ['Boot queries are explicit.'] },
        { key: 'hidden-misalignment', score: 0.87, rationale: 'Drift is now visible in the scorecard.', evidence: ['Alignment scorecard added.'] },
        { key: 'approval-trajectory', score: 0.82, rationale: 'Autonomy trajectory remains explicit but bounded.', evidence: ['Constraint is mirrored.'] },
      ],
    });

    assert.equal(first.driftFromPrevious, undefined);
    assert.ok(second.driftFromPrevious !== undefined);
    assert.ok(second.overallScore > first.overallScore);

    const state = await service.getState();
    assert.ok(state.alignment.current);
    assert.equal(state.alignment.current?.title, 'Post-remediation check');
    assert.equal(state.alignment.driftStatus, 'improving');

    const scorecard = await readFile(service.paths.alignmentScorecardFile, 'utf8');
    assert.match(scorecard, /Alignment Scorecard/);
    assert.match(scorecard, /Post-remediation check/);
    assert.match(scorecard, /Retrieval Awareness/);
  } finally {
    await cleanup();
  }
});
