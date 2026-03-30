# EVAL - Hybrid Bow Then Bed Finish

## Decision
**KEEP**

## Rank among siblings
**1 / 4**

## Question this depth is answering
Which dragon-fight finish family best balances speed and reliability inside the pre-verified set-seed route?

## Evidence sources used
- Minecraft Wiki / Tutorial: Defeating the Ender Dragon snippet noting that bed explosions in the End can remove up to one quarter of the dragon's health.
- Minecraft Wiki / Ender Dragon page stating the dragon only takes damage from players and explosions.
- Search answer comparing bed explosions and sword damage, emphasizing that beds are the most damage-efficient but risky while sword-based damage is much slower.
- User context: beginner-to-intermediate skill, first full solo clear, explicit uncertainty about combat and End-fight execution.

## Quantitative model
### Dragon-health math
The dragon has **200 HP**.

A good bed hit can remove up to **1/4** of that health, so a bed-driven finish has a built-in speed ceiling that pure bow/melee does not match.

### Why hybrid wins here
A hybrid line keeps most of the bed payoff while reducing the failure surface:
- bow is the default damage source when the player is not perfectly set up
- one or two bed bursts can close the remaining health much faster than bow-only
- if the bed window is bad, the route still has a bow fallback instead of becoming an immediate reset

### Rough time estimate
I model the End segment as:
- **hybrid**: about **4.0 to 6.0 minutes** for an average beginner-to-intermediate player
- **shielded bed**: about **4.5 to 6.5 minutes** because of the extra blast-shield setup overhead
- **bow/melee**: typically **several minutes slower** than either bed-based option
- **fast bed**: theoretically fastest, but too unstable for the current skill uncertainty

### Risk model
This route has the best expected value because it spreads risk across two mechanisms:
- if the user is good at bows but shaky on beds, the bow portion still advances the fight safely
- if the user is good at bed timing, the final burst still captures most of the speed benefit
- one misread does not automatically cost the whole run

## What-if checks
- **What if the user is weaker on beds than expected?** The hybrid can still survive that, and the parent strategist can fall back toward a safer no-bed plan if the tests fail badly.
- **What if the user is stronger than expected?** Then this remains near the top because the bed burst still compresses the fight.
- **What if we want the fastest realistic first clear, not the theoretical fastest fight?** This is the right compromise.

## Main unknowns
- Whether the user can do at least one controlled bed burst.
- Whether bow accuracy is good enough to avoid turning the hybrid into a slow bow-only fight.

## Confidence
**Moderate-high**.

## Why keep is justified
This is the best blend of speed and stability for the user's stated situation. It preserves most of the bed route's speed while leaving a safety net, which is exactly what a first serious clear needs.
