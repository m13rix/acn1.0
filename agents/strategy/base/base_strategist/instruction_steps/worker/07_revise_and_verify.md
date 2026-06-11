# Worker Step 7: Revise And Verify Iteration

Run a local verification pass.

Check:
- every sibling route exists in strategy state;
- every sibling has intake and eval files;
- decisions in route state match eval files;
- the sibling set is one category and one abstraction level;
- calculations or operational proxies are explicit enough to justify ranking;
- what-if checks were done before killing promising routes;
- any `DEPTH_PLAN.md` revision is explicit and justified;
- the parent route is marked as having generated subroutes when appropriate.

If new evidence changes an earlier local judgment, revise the affected intake/eval/decision before finishing.

If a missing fact blocks ranking, mark the precise artifact `[blocked]` and state exactly what is missing.

Finish with executable `TASK_DONE("Completed the assigned route iteration.")`.
