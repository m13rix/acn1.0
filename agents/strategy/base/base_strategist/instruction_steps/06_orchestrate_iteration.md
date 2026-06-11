# Step 6: Orchestrate Current Depth Iterations

You are orchestrating, not doing route work.

Required actions:
- ensure there is exactly one conceptual root/start route for the strategy before launching automation;
- create that root route with `strategy.routes.create(strategyId, { name, summary, category: "root", depth: START_DEPTH, rootWorkspace: true })`;
- choose `START_DEPTH` from `DEPTH_PLAN.md`; it is not always 1;
- call `strategy.iteration.begin(strategyId, { startDepth: START_DEPTH })`.

The iteration runtime will:
- use this agent's subagent prompt and worker instruction algorithm;
- launch the worker for at most one non-killed pending route at each depth;
- pass the route id, folder, intake path, eval path, current depth, and child depth to the worker;
- switch the worker model to `gpt-5.4-mini` once current depth is beyond half of max depth;
- stop when max depth is reached or when no valid pending route remains.

Do not personally create real route sibling sets.
Do not personally evaluate siblings.
Do not personally run route comparison tests.

Because this is mostly bookkeeping and delegation, the preferred model for this step is cheaper.

Advance when `strategy.iteration.begin(...)` returns and its stop reason is recorded in `WORKLOG.md`.
