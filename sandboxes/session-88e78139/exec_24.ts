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


const result = await agents.call('strategy_iteration_worker', [
  'Strategy ID: strat_414a6c936811',
  'Current depth: 3',
  'Current point type: ROUTE',
  'Parent route ID: route_dacd2039e69f',
  'Parent route name: Pre-verified Set Seed Execution',
  'Parent route folder: strategy_workspace/routes/preverified-set-seed-execution',
  'Parent route summary: Choose a known good 1.21.11 seed ahead of time, then execute a fixed, repeatable village-to-Nether-to-End plan with minimal world-search variance.',
  'Task: execute one full depth-3 iteration under this parent route, focusing on the opener / early-game plan inside the chosen seed family.',
  'The user wants a fast but realistic and stable plan. They are willing to use a chosen seed and short tests.',
  'Create a coherent sibling set at the same abstraction level that compares the main opener choices for the chosen seed family.',
  'Likely candidates include village-first opener, ruined-portal-first opener, and direct lava-pool rush opener, but choose the actual sibling set based on evidence.',
  'Use the existing route evidence, seed-map planning constraints, and user-skill calibration concerns.',
  'Write route intake/evaluation files, apply keep/kill, and mark the best opener family for expansion.',
  'Also update TESTS.md with the minimum concrete skill tests needed before the real attempt.'
].join('\n'));
console.log(String(result));
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
