# EVAL — Seed-Map Scout-and-Set

## Decision
**KEEP**

## Rank among siblings
**3 / 4**

## Question this depth is answering
Should the strategy spend time scouting a custom seed with external maps before committing to the run?

## Evidence sources used
- Chunk Base Seed Map documentation and app listing.
- mcseedmap.net documentation about structure accuracy limits.
- Speedrun.com guide index showing that structure / seed tooling is part of the speedrun ecosystem.
- Current set-seed / random-seed run examples for the same version family.

## Quantitative model
### Time tradeoff
Seed-map scouting can reduce the in-run travel burden, but it adds a nonzero pre-run cost.
If scouting saves only a small amount of run time, the net gain is negative once planning time is counted.

A realistic comparison looks like this:
- **Pre-verified set seed**: near-zero scouting time, strong run stability
- **Seed-map scout-and-set**: several minutes of scouting / comparison, possibly a slightly better world

To beat the pre-verified option, the scouting would need to save enough run time to offset the setup cost. For a beginner-to-intermediate player, that bar is fairly high.

### Why it is still worth keeping
- It can produce a route that is easier than the default seed if the user wants a custom world.
- It is compatible with the user’s stated willingness to use chosen seeds and external planning tools.
- It is a real optimization branch, not a gimmick.

## What-if checks
- **What if the user wants maximum personalization?** This branch improves personalization the most.
- **What if the user wants the fastest first clear overall?** Then the extra scouting time usually loses to the pre-verified seed family.
- **What if the chosen seed is only slightly better?** The branch should be pruned later.

## Main unknowns
- How large the world improvement really is versus the extra setup time.
- Whether the seed-map result is sufficiently reliable for the chosen version and structure type.

## Confidence
**Medium**.

## Why keep is justified
This family is legitimate and potentially useful, but it is usually a secondary optimization behind a known good seed. It survives because it could still be the right move if a custom world meaningfully simplifies the opener.
