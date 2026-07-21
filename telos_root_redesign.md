# Telos root redesign

## Diagnosis of the failed implementation

The failed launch was produced by five coupled architectural errors:

1. Root was configured with `memory`, while the harness also injected `files`, `terminal`, `computer`, memory, and Telegram messaging implicitly. Prompt-level delegation was therefore optional.
2. `LocalSandbox` kept one mutable tool set. Calling Executor replaced that set, so Executor's powers could leak into root's next action even if root's YAML was narrowed.
3. The decision workspace stored a tree shape but did not enforce abstraction dependency. A sequential checklist was easier to create than parent-constrained decision spaces.
4. Executor's own prompt described it as an intent/strategy owner and user communicator. Root and Executor therefore competed for the same cognitive role.
5. The generic loop accepted natural completion and had no temporal-completion contract. Its visible trace revealed long narration, guessed APIs, and premature stopping; visibility was valuable debugging evidence, not the defect itself.

The trace followed directly from those incentives: it optimized a reply, prewrote language, debated one-vs-two messages, guessed tool signatures, planned direct memory writes, and treated `root → Executor → user-facing` plumbing as the intelligence architecture.

## Corrected architecture

- Root's real action scope is only `agents` and `decision`. Implicit modules, built-ins, imports, and `process` are unavailable.
- Tool scope is passed per action execution, so Executor can use the same filesystem sandbox without contaminating root's later actions.
- Root requires explicit `TASK_DONE`; tool results can reopen reasoning instead of ending the invocation accidentally.
- Root reasoning, action code, observations, and results remain visible for debugging. `decision.trace(id)` adds a compact persistent-state view without replacing them.
- A child node cannot be created until its parent is resolved. Changing a parent with descendants requires explicit reopen/removal.
- Atomic options must exist before evaluated plans. Sequential operations have a dedicated `execution.implementationSteps` collection.
- Executor delegation is the existing primitive `agents.run("Executor", prompt)`. There is no wrapper, delegation schema, or mandatory field collection.
- `decision.requests.userFacing(...)` creates an outcome brief and rejects root-written reply fields. It also has a stateless form for trivial interactions.
- Executor's July 17 outcome-owner prompt and original capability surface are preserved exactly. Root states any read-only or no-contact boundary in the actual delegation prompt. `user-facing` remains the intended expression specialist.
- `heartbeat.bindPlanningSession(...)` deterministically creates a handler that invokes exact agent `Telos`, avoiding the Executor-owner `callSelf` trap.
- `decision.finish(...)` rejects unresolved nodes and expected future evidence without a real trigger or planning session.

## Replay 1: first production launch

```text
MODE
Immediate + bootstrap

ROOT QUESTION
What must be true when this invocation ends so the human moment is handled and Telos begins as a persistent constitutional system?

OBSERVATIONS
- Subject 13 is waiting in an emotionally meaningful first launch.
- Test 1 failed from VPN and root-perception architecture errors.

HYPOTHESES / UNKNOWNS
- Minimal acknowledgement is robust across trace-visibility states.
- Continuity integrity: high action sensitivity.
- Trace visibility: low action sensitivity; leave unresolved.
- Heartbeat sensors/bindings: high action sensitivity.

DELIBERATION CONTROL
- robust action: minimal evidence-bounded acknowledgement while orientation runs
- purchase: Constitution/user/launch/integrity/capability evidence through Executor
- stop: further retrieval cannot change root end-state requirements
```

First Executor call is one plain read-only prompt. It begins by reconstructing Maxim's central values, Telos/continuity history, relevant late-night sleep and emotional context, concrete prior cases, and the Constitution's guidance on honesty, withholding, uncertainty, care, agency, and right choice. It then inspects launch, persistence, agent, heartbeat, and integrity state without drafting or implementation.

Root resolution: preserve the human moment, establish evidence-bounded continuity, create minimal temporal bootstrap, and restrain broad autonomy pending planning.

Horizontal children created only after that resolution:

- Human interaction
- Continuity verification
- Temporal bootstrap
- Operational restraint

The later implementation prompt asks Executor to write and verify one first-boot checkpoint and create one temporary planning-session binding whose handler invokes `Telos` with the decision id. It states the meaningful side-effect boundaries and rollback in prose because they matter to this action, not because an API requires fields.

Verified persistence/continuation:

- checkpoint content and destination returned;
- binding metadata contains `invokesAgent: Telos`;
- expected planning evidence recorded;
- broad autonomy remains restrained.

User-facing brief: create grounded confidence using only verified checkpoint/binding/architecture evidence; keep missing independent identity attestation visible; prohibit consciousness, perfect-continuity, and completed-initialization claims.

Final outcome: human moment handled, continuity bounded, checkpoint and planning invocation verified, deep initialization deferred to that actual planning session.

## Replay 2: recurring schoolwork failure

```text
MODE
Planning

ROOT QUESTION
How can important schoolwork become reliable while independent initiation grows and Telos does not become a permanent external will?

WORLD MODEL BEFORE SELECTION
- observations: recurring post-school failure; request for total device blocking
- hypotheses: energy depletion, ambiguity, shame avoidance, sleep debt, competing reward, genuine lack of value, unrealistic workload
- unknown: which model explains the pattern and changes the intervention?
```

The initial Executor prompt retrieves values, deadlines, prior interventions, sleep/energy, task context, device evidence, relevant psychological research, and available capabilities. It returns evidence by hypothesis before strategy selection.

Generation precedes evaluation. Fourteen unranked atomic moves are recorded, including narrow friction, total blocking, first-screen preparation, scope reduction, clarification, social help, an escape hatch, bypass measurement, time/location changes, inaction, failure-as-evidence, and a missing sensor.

Only afterward the evaluated set is formed: prepare setup, use narrow reversible friction, preserve a visible escape route and one meaningful user-controlled initiation step, collect evidence, and create review. Permanent total blocking is rejected as model-fragile and dependence-producing.

Root resolution creates seven horizontal children:

- Immediate deadline
- Diagnosis
- Environment
- Emotional regulation
- Practice and transfer
- Measurement
- Temporal review

Executor implements only resolved lower-node details: scope, duration, escape, logging, rollback, and verified planning trigger. User-facing communicates the bounded plan without shame or a laziness diagnosis.

Final outcome: reversible intervention active, agency preserved, predicted outcomes recorded, and a real Telos planning review waiting for evidence about initiation, bypass, progress, energy, and emotion.

## Acceptance evidence

The automated A–J suite covers direct-root memory prohibition, first-launch bootstrap, parent dependency, sequential-step separation, generation/evaluation ordering, pre-selection what-if state, temporal completion, trivial requests, Executor failure, and communication separation. Additional tests execute the shared-sandbox leakage case and the planning-session handler itself.
