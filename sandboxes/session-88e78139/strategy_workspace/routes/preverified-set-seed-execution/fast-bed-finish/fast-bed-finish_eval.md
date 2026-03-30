# EVAL - Fast Bed Finish

## Decision
**KILL**

## Rank among siblings
**4 / 4**

## Question this depth is answering
Which dragon-fight finish family best balances speed and reliability inside the pre-verified set-seed route?

## Evidence sources used
- Minecraft Wiki / Tutorial: Defeating the Ender Dragon snippet noting that bed explosions in the End can remove up to one quarter of the dragon's health.
- Search answer comparing bed explosions to sword damage and explicitly calling beds high-risk, high-reward.
- User context: beginner-to-intermediate skill, no full completion yet, skill should be measured rather than assumed.

## Quantitative model
### Raw upside
Beds are extremely fast in the End. Because they can deal up to **1/4 of the dragon's health** in a good cycle, a clean execution can end the fight in roughly **4 major detonations**.

### Risk penalty
The issue is not the theoretical damage; it is the failure cost.

For a user whose exact End-fight skill is still unknown, the important quantity is not just best-case speed but the expected cost of a mistake:
- a mis-timed bed can instantly kill the player
- a death in the End often costs far more time than the minutes saved by shaving a safer setup
- the route has no built-in recovery margin

If I compare the route to the shielded-bed and hybrid siblings, the added speed is too small to justify the extra reset risk for this user. One major failure wipes out the speed gain from several successful fights.

### Time estimate
On paper, this is the fastest finish family. In practice, for this user, the expected time is worsened by retries and confidence loss.

So the practical model is:
- **best case**: fastest sibling
- **expected case for this user**: slower than the safer bed variants because of reset risk

## What-if checks
- **What if the user is secretly very good at bed timing?** Then this could be revived later, but the current evidence does not support that assumption.
- **What if the tests prove the user can chain bed detonations cleanly?** Then this route can be reopened in a later iteration.
- **What if the user wants maximum stability on the first serious clear?** Then this route is the wrong default.

## Main unknowns
- The user's true End-fight timing skill.
- Whether the user can avoid self-kills under pressure.

## Confidence
**High**.

## Why kill is justified
This route is the pure speed play, but the user has not yet proven the specific mechanic it depends on. For this strategy, a raw-speed bed line is not the best first-choice finish family.
