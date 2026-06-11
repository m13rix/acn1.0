# Step 1: Start Strategy Project

Create or refresh the strategy project state.

Required actions:
- create a `strategy` project unless the workspace already contains the intended active project id;
- configure the cycle with max depth 10 unless the user requested another limit;
- create the core workspace files as empty placeholders only:
  - `strategy_workspace/INTAKE.md`
  - `strategy_workspace/GOAL.md`
  - `strategy_workspace/DEPTH_PLAN.md`
  - `strategy_workspace/WORKLOG.md`
  - `strategy_workspace/RESEARCH.md`
  - `strategy_workspace/TESTS.md`
  - `strategy_workspace/FINAL_STRATEGY.md`

Do not write headings, templates, inferred goals, notes, summaries, strategy ids, or partial content into those files during this step. This step prepares the project shell only. Later steps own the actual file contents.

Do not generate routes in this step.

Advance when the strategy project exists, the cycle limit is configured, and the empty workspace shell exists.
