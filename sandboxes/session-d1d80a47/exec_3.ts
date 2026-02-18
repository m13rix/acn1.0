require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


const fs = require('fs');

// Check if research file was created
if (fs.existsSync('./research_psychology.md')) {
  const content = fs.readFileSync('./research_psychology.md', 'utf-8');
  console.log("Research file created. Length:", content.length);
  console.log("\n--- First 3000 chars ---\n");
  console.log(content.substring(0, 3000));
} else {
  console.log("Research file not yet created. Waiting...");
}
})().catch(err => {
  console.error(err);
  process.exit(1);
}).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exit(1);
});
