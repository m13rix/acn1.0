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


const res = await search.answer(
  'Find a practical Minecraft Java 1.21.11 set-seed or seed-map-friendly seed for a fast beginner-friendly normal-difficulty completion route. Prefer a seed with close village, easy lava, and manageable Nether access. If no single authoritative seed is obvious, summarize what kind of seed to pick and why.',
  { topic: 'general', searchDepth: 'advanced', output: 'answerAndUrls' }
);
console.log(JSON.stringify(res, null, 2));
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
