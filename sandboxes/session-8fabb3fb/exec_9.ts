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


// Check which files were created
const fs = require('fs');

const filesToCheck = [
  'maxim_psychology.md',
  'maxim_cognitive.md',
  'maxim_philosophy.md',
  'maxim_relationships.md'
];

filesToCheck.forEach(file => {
  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf-8');
      console.log(`${file}: ${content.length} characters, ${content.split('\n').length} lines`);
      console.log(`First 500 chars: ${content.substring(0, 500)}...`);
      console.log('---');
    } else {
      console.log(`${file}: NOT FOUND`);
    }
  } catch (e) {
    console.log(`${file}: ERROR - ${e.message}`);
  }
});
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
