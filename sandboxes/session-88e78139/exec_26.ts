require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const strategy = require('../../tools/strategy/index.ts');
const utils = require('../../tools/utils/index.ts');
const minecraft = require('../../tools/minecraft/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


const test = await minecraft.conductTest(`You are testing a real Minecraft Java Edition 1.21.11 player named M13RIX on normal difficulty (single-player style), with Telos as the bot. The goal is NOT to win the game; it is to measure skill relevant to a fast, stable completion route.

Please run a compact three-part skill battery and report the results clearly with timestamps / outcomes / notable mistakes:

PART A — Opener / inventory test (5 minutes max)
- Start in a fresh survival-like context.
- Ask the player to quickly gather basic starter resources from a village-like opener or equivalent controlled setup: wood, food, beds, and any obvious iron.
- Measure: speed of inventory handling, whether they forget items, whether they can keep moving, and whether they can manage hotbar efficiently.

PART B — Basic combat test (3 to 5 minutes)
- Spawn a few standard hostile mobs appropriate for normal difficulty (zombies, skeletons, maybe a stray spider).
- Measure: shield usage, kiting, taking unnecessary damage, panic, and ability to survive without repeated mistakes.

PART C — End-fight finish-method test (3 to 5 short reps)
- In a controlled safe setup, test the player’s comfort with dragon-fight-relevant damage methods.
- First try a bed-based detonation timing drill with a simple blast-shield / safety pattern.
- If the player struggles, also test a bow-first / bed-finisher hybrid timing drill.
- Measure: can they place/aim correctly, avoid self-kills, and understand when to switch from ranged damage to finish damage.

Please conclude with:
1) A rough skill tier estimate for the player (low / mid / high relative to beginner-to-intermediate speedrun needs).
2) Whether the main route should prefer:
   - pure bed finish,
   - hybrid bow-then-bed,
   - or bow-and-melee fallback.
3) The most important failure patterns to avoid.
4) Any short practice recommendations that would materially improve the first real run.

Keep the test concise. Time spent on the test does not count toward the run.`);
console.log(JSON.stringify(test, null, 2));
})().then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(async err => {
  console.error(err);
  process.exitCode = 1;
  await new Promise(resolve => setTimeout(resolve, 200));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exitCode = 1;
});
