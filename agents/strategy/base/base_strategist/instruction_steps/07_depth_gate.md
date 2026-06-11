# Step 7: Check Depth Readiness And Ask User

Check what the automatic iteration runtime produced.

Required actions:
- call `strategy.cycle.depthSummary(...)`;
- inspect the `strategy.iteration.begin(...)` result recorded in `WORKLOG.md`;
- if undecided routes remain, decide whether they are harmless losing siblings, a real block, or a sign the worker failed;
- if no kept routes remain, prepare final synthesis or stop with no-worthy-route explanation;
- if the runtime stopped before max depth because no valid pending route remained, determine whether this is a natural stopping point or an artifact error.

Ask the user only if the stop reason is ambiguous and materially changes whether to synthesize or repair.

If the recursive route tree is deep enough or reached max depth:
- jump to `final_synthesis` with `instruction.set("final_synthesis", "automatic iteration complete")`.

If a repair is needed:
- document the exact route/depth failure in `WORKLOG.md`;
- jump back to `orchestrate_iteration` only if another `strategy.iteration.begin(...)` call is the correct repair.

Because this is mostly cycle control, the preferred model for this step is cheaper.
