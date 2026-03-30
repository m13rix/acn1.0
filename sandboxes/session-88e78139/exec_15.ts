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
  'Current depth: 2',
  'Current point type: ROUTE',
  'Parent route ID: route_dacd2039e69f',
  'Parent route name: Pre-verified Set Seed Execution',
  'Parent route folder: strategy_workspace/routes/preverified-set-seed-execution',
  'Parent route summary: Choose a known good 1.21.11 seed ahead of time, then execute a fixed, repeatable village-to-Nether-to-End plan with minimal world-search variance.',
  'Task: execute one full depth-2 iteration under this parent route.',
  'Important context: user wants the fastest route that is still realistically executable and stable; they are willing to use a chosen seed and short practice tests.',
  'Your job is to identify the most important same-level fork inside this family. A likely fork is the dragon-fight finish method and any other closely related opener/finish variants that materially change speed/reliability.',
  'Create a coherent sibling set with one shared theme and one shared abstraction level. Do not mix unrelated categories.',
  'Write route intake and evaluation files for each child route, apply keep/kill, and mark subroutes generated as needed.',
  'Use the existing user-skill uncertainty to influence the ranking; if necessary, add a small test battery to TESTS.md.',
  'Do not advance the cycle yourself; report the result of this iteration so the orchestrator can ask the user whether to continue deeper.'
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
