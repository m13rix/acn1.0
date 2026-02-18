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

// View all the files mentioned
const files = [
  './intake.md',
  './telos_context_13.md', 
  './interview_questions.md',
  './user_answers.md'
];

for (const file of files) {
  console.log(`\n\n========== ${file} ==========\n`);
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    // Show first 5000 chars to not overwhelm
    console.log(content.substring(0, 5000));
    if (content.length > 5000) {
      console.log(`\n... [${content.length - 5000} more characters] ...`);
    }
  } else {
    console.log(`FILE NOT FOUND: ${file}`);
  }
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
