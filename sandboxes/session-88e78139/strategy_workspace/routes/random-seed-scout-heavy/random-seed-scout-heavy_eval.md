# EVAL — Random-Seed Scout-Heavy

## Decision
**KILL**

## Rank among siblings
**4 / 4**

## Question this depth is answering
Is a random-seed, restart-heavy scouting family competitive for the user’s stated goal?

## Evidence sources used
- Speedrun.com / YouTube examples showing a **1.21.11 random-seed glitchless run around 51:52** and a **set-seed run at 19:13**.
- Speedrun.com category pages showing random seed and set seed are distinct families.
- The user’s preference for a fast, stable, realistically executable strategy and willingness to use a chosen seed.

## Quantitative model
### Relative speed
Representative current-version evidence suggests that random-seed execution is dramatically slower than set-seed execution.
A rough comparison from the gathered examples is:
- **set seed**: ~19 minutes representative run
- **random seed**: ~52 minutes representative run

That is already about a **2.7x** difference in a favorable sample, before accounting for beginner mistakes and restart overhead.

### Risk profile
Random-seed scouting has extra hidden costs:
- restart fishing for a decent spawn,
- more judgment calls during the opener,
- more chance of getting a bad world and wasting time,
- more punishment when execution slips.

For a beginner-to-intermediate solo player, the expected first-clear time is therefore much worse than the seeded alternatives.

## What-if checks
- **What if the user were forbidden from choosing a seed?** Then this family would become relevant again.
- **What if the user were already speedrun-strong?** The family would still be slower than the seeded line, though the gap might matter less.
- **What if one exceptionally good random world appears?** That is too inconsistent to build the main strategy around.

## Main unknowns
- None that are strong enough to rescue the family at this depth.

## Confidence
**High**.

## Why kill is justified
The user is explicitly allowed to use a chosen seed, and the goal prioritizes speed plus stability. Random-seed scout-heavy is both slower and less reliable than the seeded alternatives, so it is dominated at depth 1 and does not deserve more recursion budget here.
