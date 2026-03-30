require('./globals.js');
const files = require('../../tools/files/index.ts');
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


const sid='strat_414a6c936811';
const updates = [] as any[];
await strategy.routes.keep(sid, 'route_fac2a738d6d2', { reason: 'Best speed/reliability compromise for a first serious clear inside a set-seed opener: retains bow fallback while preserving most bed speed.', evidence: 'Dragon health 200 HP; bed explosions can remove up to 1/4 of dragon health; user skill is still uncertain, so hybrid reduces reset risk versus pure bed.', confidence: 0.8, rank: 1 });
await strategy.routes.keep(sid, 'route_4c9c9bd24d2f', { reason: 'Shielded bed finish keeps bed speed while lowering self-kill risk, a strong secondary option if the user can memorize a shield pattern.', evidence: 'Bed explosions are high-damage but risky; shielded setup reduces blast exposure relative to all-in beds.', confidence: 0.72, rank: 2 });
await strategy.routes.kill(sid, 'route_45e05c40e844', { reason: 'Too slow for this parent route unless bed-based execution proves impossible; bow/melee adds several fight cycles and cumulative risk.', evidence: 'Pure bow/melee requires many more hits to remove 200 HP than bed-based finishes; search guidance stresses beds are far more damage-efficient.', confidence: 0.84, rank: 3 });
await strategy.routes.kill(sid, 'route_6e8c4d5a9e1d', { reason: 'Fast bed is the highest raw-speed option, but for an unmeasured player it is too fragile and reset-prone.', evidence: 'Search guidance explicitly frames bed detonations as high-risk; a single misplacement can kill the player and waste the run.', confidence: 0.92, rank: 4 });
await strategy.routes.markSubroutesGenerated(sid, 'route_dacd2039e69f', { note: 'Depth-2 dragon-fight finish family generated and evaluated under pre-verified set-seed execution.' });
const parent = await strategy.routes.get(sid, 'route_dacd2039e69f');
console.log(JSON.stringify(parent, null, 2));
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
