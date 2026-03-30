# EVAL - Shielded Bed Finish

## Decision
**KEEP**

## Rank among siblings
**2 / 4**

## Question this depth is answering
Which dragon-fight finish family best balances speed and reliability inside the pre-verified set-seed route?

## Evidence sources used
- Minecraft Wiki / Java Edition 1.21.11 page for bed rule behavior and current-version context.
- Minecraft Wiki / Ender Dragon page stating the dragon only takes damage from players and explosions.
- Minecraft Wiki / Tutorial: Defeating the Ender Dragon snippet noting that bed explosions in the End can remove up to one quarter of the dragon's health.
- Search answer comparing bed explosions with sword-based damage and noting bed detonations are high-damage but risky.

## Quantitative model
### Core mechanics
- Ender Dragon health: **200 HP**.
- Bed explosions are the highest-damage End finisher and can remove **up to 1/4 of the dragon's health** per good use.
- That means a clean bed sequence can theoretically finish the fight in about **4 major damage cycles** instead of a much longer bow/melee grind.

### Time estimate
Compared with a pure bow/melee finish, shielded beds should usually save about **1 to 3 minutes** in the dragon segment because the fight ends in fewer damage windows.

The shield adds a little setup overhead, so I model the fight segment as roughly:
- **shielded bed finish**: about **4.5 to 6.5 minutes** in the End segment for an average beginner-to-intermediate player
- **pure bow/melee**: typically slower than that, often by several more damage windows
- **fast bed**: faster in theory, but only if the user can execute without error

### Risk model
The shield lowers self-kill risk relative to pure beds, but it still depends on:
- correct perch recognition
- correct block placement
- correct blast spacing

That makes it materially safer than the fastest bed route, but not as simple as a bow-only fallback.

## What-if checks
- **What if the user is shaky on bed timing?** This route still has a chance because the shield reduces blast exposure, but the confidence should drop.
- **What if the user is comfortable with shield placement?** Then this becomes one of the best speed/reliability balances in the sibling set.
- **What if the user fails the timing test completely?** Then this should lose to Practice-First Calibration rather than being forced into the run.

## Main unknowns
- Whether the user can place the shield block from muscle memory.
- Whether the extra block placement is too slow under stress.
- Whether the user can survive one mistake without a reset.

## Confidence
**Moderate-high**.

## Why keep is justified
This route keeps most of the bed route's speed while cutting down the biggest failure mode. It is a better default than all-in fast beds for a player whose End-fight skill is still being measured.
