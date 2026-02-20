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

console.log('=== Reading maxim_intake.md ===');
try {
    const intake = fs.readFileSync('maxim_intake.md', 'utf-8');
    console.log(intake);
} catch (e) {
    console.error('Error reading maxim_intake.md:', e);
}

console.log('\n=== Reading telos_context_13.md ===');
try {
    const telos = fs.readFileSync('telos_context_13.md', 'utf-8');
    console.log(telos);
} catch (e) {
    console.error('Error reading telos_context_13.md:', e);
}

console.log('\n=== Reading user_answers.md ===');
try {
    const answers = fs.readFileSync('user_answers.md', 'utf-8');
    console.log(answers);
} catch (e) {
    console.error('Error reading user_answers.md:', e);
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
