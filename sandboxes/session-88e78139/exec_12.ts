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


const result = await files.View([
  'strategy_workspace/routes/preverified-set-seed-execution/preverified-set-seed-execution_intake.md',
  'strategy_workspace/routes/preverified-set-seed-execution/preverified-set-seed-execution_eval.md',
  'strategy_workspace/routes/practice-first-calibration/practice-first-calibration_intake.md',
  'strategy_workspace/routes/practice-first-calibration/practice-first-calibration_eval.md',
  'strategy_workspace/routes/seed-map-scout-and-set/seed-map-scout-and-set_intake.md',
  'strategy_workspace/routes/seed-map-scout-and-set/seed-map-scout-and-set_eval.md'
]);
console.log(JSON.stringify(result, null, 2));
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
