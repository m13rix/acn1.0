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


// Read existing analyses to check their quality
const fs = require('fs');

const psych = fs.readFileSync('maxim_psychology.md', 'utf-8');
const cognitive = fs.readFileSync('maxim_cognitive.md', 'utf-8');
const relations = fs.readFileSync('maxim_relationships.md', 'utf-8');

console.log("=== PSYCHOLOGY ANALYSIS ===");
console.log(`Length: ${psych.length} chars`);
console.log("Key sections found:");
console.log(psych.includes('IDENTITY FORMATION') ? '✓ Identity Formation' : '✗');
console.log(psych.includes('GIFTEDNESS') ? '✓ Giftedness Markers' : '✗');
console.log(psych.includes('ATTACHMENT') ? '✓ Attachment Patterns' : '✗');

console.log("\n=== COGNITIVE ANALYSIS ===");
console.log(`Length: ${cognitive.length} chars`);
console.log("Key sections found:");
console.log(cognitive.includes('SYSTEMIC THINKING') ? '✓ Systemic Thinking' : '✗');
console.log(cognitive.includes('META') ? '✓ Metacognition' : '✗');

console.log("\n=== RELATIONSHIPS ANALYSIS ===");
console.log(`Length: ${relations.length} chars`);
console.log("Key sections found:");
console.log(relations.includes('14') ? '✓ 14 Analysis' : '✗');
console.log(relations.includes('FRIENDSHIP') ? '✓ Friendship Patterns' : '✗');
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
