# Worker Step 6: Apply Keep/Kill Decisions

Apply route decisions in the `strategy` tool.

Default pruning schedule:
- depth 1: conservative; keep plausible broad families unless fake, impossible, or mechanically dead;
- depth 2: prune roughly half unless evidence strongly says otherwise;
- depth 3 and deeper: usually keep the single strongest child under each parent.

Use:
- strategy.routes.keep(strategyId, routeId, { reason, evidence?, confidence?, rank? })
- strategy.routes.kill(strategyId, routeId, { reason, evidence?, confidence?, rank? })
- rank, evidence, confidence, and decision reason.

Example:
```
const outcome1 = await strategy.routes.keep("strat_4de156f4687c", "route_48f9d6bd5350", {
  reason: "Strongest evidence fit (8.70/10). Direct GOAL.md primary metric alignment (Journaling Consistency >5 days/week). Leverages Maxim's metacognition. Clear obsolescence path. Lowest friction at 3-5 min/day.",
  rank: 1
});
```

Do not keep everything because you are uncertain. Uncertainty can justify survival only when the route has meaningful upside or information value.

Do not kill a high-upside route just because it is unusual. Kill it only when evidence, constraints, risk, or expected value justify the kill.

Advance when strategy state matches the eval files.
