# Step 2: Build Intake

Build `strategy_workspace/INTAKE.md` as the truth map for the problem.

Include:
- exact user request;
- hard constraints and forbidden methods;
- allowed tools, agents, tests, and external resources;
- environment details;
- Subject 13 personal context that could affect execution;
- what the user already knows;
- what can be tested;
- unknowns that could change the route tree;
- what is outside scope.

Use memory early:
- search for the user/problem/domain;
- search for prior strategy-engine doctrine if not already surfaced;
- ignore irrelevant memory instead of forcing it.

Ask the user only for facts that are not retrievable and would materially change the tree.

Advance when `INTAKE.md` is concrete enough that a worker would not need to rediscover the basic task.
