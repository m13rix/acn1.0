# EVAL — Practice-First Calibration

## Decision
**KEEP**

## Rank among siblings
**2 / 4**

## Question this depth is answering
Is a short skill-measurement phase worth the time because the user’s actual skill is still unknown?

## Evidence sources used
- User statement that skill should be measured through tests rather than guessed.
- Goal document emphasizing that faster-but-too-hard routes should lose to slightly slower but more executable ones.
- Current route comparison showing a large difference in stability between set-seed and random-seed families.

## Quantitative model
### Why practice can be worth it
The cost of a bad first attempt can be large: a failed run can easily waste 20+ minutes.
If a short calibration battery prevents even one major mistake, it can pay for itself quickly.

### Why it is not rank 1
Practice adds upfront time, so it only wins if the user actually needs it.
If the user already handles the opener, combat, and End-fight patterns comfortably, then extra practice becomes pure overhead.

### Break-even logic
A calibration block is justified when it reduces the probability of a costly failure enough to offset its own time.
That means this branch is especially useful when:
- the user is unsure about combat or inventory management,
- the user has never completed the game solo,
- the dragon method is likely to be the bottleneck.

## What-if checks
- **What if the user passes the tests easily?** Then this branch mostly collapses into confirming the pre-verified set-seed plan.
- **What if the user struggles?** Then this branch becomes the best protection against wasting a full run.
- **What if the user wants speed only?** Then it should remain short and targeted, not become a long practice arc.

## Main unknowns
- The user’s current real skill tier.
- Which exact subskills matter most for the final route.

## Confidence
**Medium-high** that this should remain available as a top-level calibration family.

## Why keep is justified
This is not the fastest pure run plan, but it is strategically important because it resolves the biggest unresolved variable in the project: actual player skill. Since the user explicitly asked for tests, this branch has real value.
