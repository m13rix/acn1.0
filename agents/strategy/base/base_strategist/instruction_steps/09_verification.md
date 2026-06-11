# Step 9: Verify And Finish

Run a final verification pass.

Check:
- `INTAKE.md`, `GOAL.md`, `DEPTH_PLAN.md`, `WORKLOG.md`, and `FINAL_STRATEGY.md` exist;
- route decisions match their eval files;
- no current-depth required point remains undecided unless explicitly blocked;
- the final synthesis cites or reflects the real route artifacts;
- no main-strategist route work violated the orchestrator/worker boundary;
- the stopping condition is real: user stop, max depth, no worthy routes, or completed sufficient exploration.

If verification fails, jump to the needed step with `instruction.set(...)`.

If verification passes, finish with `TASK_DONE("Strategy creation complete.")`.
