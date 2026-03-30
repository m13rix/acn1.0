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


const r = await search.crawl('https://minecraft.wiki/w/Ender_Dragon', 'Extract the official statements about what kinds of damage the ender dragon takes, its total health, and anything relevant to comparing bed explosions vs bow/melee damage. Return concise quoted facts only.'); console.log(JSON.stringify(r, null, 2));
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
