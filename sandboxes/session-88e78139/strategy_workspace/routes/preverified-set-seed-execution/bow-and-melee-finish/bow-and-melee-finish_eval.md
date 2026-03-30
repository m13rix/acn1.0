# EVAL - Bow and Melee Finish

## Decision
**KILL**

## Rank among siblings
**3 / 4**

## Question this depth is answering
Which dragon-fight finish family best balances speed and reliability inside the pre-verified set-seed route?

## Evidence sources used
- Minecraft Wiki / Ender Dragon page noting the dragon only takes damage from players and explosions.
- Search answer stating that a sword is much slower than bed explosions and that bed explosions are far higher damage per use.
- Minecraft Wiki / Tutorial: Defeating the Ender Dragon snippet noting beds can remove up to 1/4 of the dragon's health per good use.

## Quantitative model
### Damage comparison
The Ender Dragon has **200 HP**.

A pure bow/melee finish has to spend that health budget through many smaller hits:
- the search result notes a Sharpness V sword maxes around **10 damage / 5 hearts** per hit
- that means a full-health dragon would need on the order of **20 hits** even before accounting for imperfect positioning, missed hits, and flight windows
- bow damage is also smaller per shot than a good bed detonation, so the real count is usually even worse

### Time comparison
Because the dragon only gives short attack windows, a bow/melee finish usually means:
- more perch cycles
- more time exposed to dragon breath and knockback
- more total opportunities for a mistake

Relative to the bed-based families, this likely adds **several minutes** to the End segment. For a seed-optimized overall run, that is a real cost.

### Reliability tradeoff
This route is safer in the narrow sense that it avoids bed self-kills, but it is not the best answer to this depth because:
- the user's route family already exists to reduce early variance
- the remaining hard part is not opener variance; it is the dragon finish
- slower fights increase cumulative failure risk anyway

## What-if checks
- **What if the user cannot handle beds at all?** Then Practice-First Calibration is the right parent-level answer, not this slower sibling.
- **What if the user wants the simplest possible finish?** This route is simple, but not fast enough to beat the better bed-based options.
- **What if the user is extremely weak at combat?** The route may still be usable, but it is outside the best fast/stable frontier for this parent.

## Main unknowns
- Whether the user truly needs a no-bed fallback.
- Whether the extra fight length causes more mistakes than the bed routes would.

## Confidence
**Moderate-high**.

## Why kill is justified
This is reliable, but it is too slow for the current parent route unless the user proves they cannot do any bed-based finish. That is a test result, not the default assumption.
