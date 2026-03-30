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
const parent='route_dacd2039e69f';
const batch = await strategy.routes.createBatch(sid, {
  parentRouteId: parent,
  theme: 'Fast, stable, beginner-friendly solo full completion for Minecraft Java 1.21.11',
  category: 'Depth 2 dragon-fight finish families inside pre-verified set-seed execution',
  routes: [
    {
      name: 'Shielded Bed Finish',
      slug: 'shielded-bed-finish',
      summary: 'Use beds as the primary End damage source, but standardize a blast-shield placement pattern so the user can survive the detonation more reliably.',
      note: 'Balancing speed and safety by keeping the bed core while adding a repeatable protection layout.'
    },
    {
      name: 'Fast Bed Finish',
      slug: 'fast-bed-finish',
      summary: 'Prioritize the quickest plausible bed-based dragon finish with minimal shielding or contingency, aiming for the fewest perches and least downtime.',
      note: 'Best raw time if the user can already time beds and manage health confidently.'
    },
    {
      name: 'Bow-and-Melee Finish',
      slug: 'bow-and-melee-finish',
      summary: 'Avoid bed detonations and finish the dragon with arrows while airborne plus melee on perch, favoring simplicity and low self-kill risk.',
      note: 'Slower, but likely the most forgiving execution route for an untested player.'
    },
    {
      name: 'Hybrid Bow-Then-Bed Finish',
      slug: 'hybrid-bow-then-bed-finish',
      summary: 'Use bow damage as the default and reserve one or two controlled bed explosions only for the final perch or a low-health threshold.',
      note: 'A middle ground that can reduce bed risk while retaining most of the bed route’s speed advantage.'
    }
  ]
});
console.log(JSON.stringify(batch, null, 2));
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
