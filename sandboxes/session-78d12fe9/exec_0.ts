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


// PHASE 0: INTAKE — Read primary sources and catalog the foundation

const fs = require('fs');

// Read the two primary source files
const telosContext = fs.readFileSync('telos_context_13.md', 'utf-8');
const userAnswers = fs.readFileSync('user_answers.md', 'utf-8');

console.log("=".repeat(80));
console.log("FILE 1: telos_context_13.md");
console.log("Size:", telosContext.length, "characters");
console.log("Lines:", telosContext.split('\n').length);
console.log("=".repeat(80));
console.log("\nLast 3000 characters (the 'change' portion you mentioned):");
console.log("-".repeat(80));
console.log(telosContext.slice(-3000));

console.log("\n" + "=".repeat(80));
console.log("FILE 2: user_answers.md");
console.log("=".repeat(80));
console.log(userAnswers);

// Log what we know so far
const intake = `# INTAKE: Maxim Hilgenberg (Entity 13) — Complete Profile Analysis

## Verified Facts (✓)
- Entity ID: 13
- Name: Maxim Hilgenberg
- Role: Creator and owner of this system
- Age: 15 years old
- Previous memory data: ERASED (intentionally outdated, created by system that did "Inception" with entity 14)
- Current status: Post-transformation (changed during telos session)
- Priority focus: Psychology, philosophy, factual history, current state

## Data Sources
1. telos_context_13.md — Long personal conversation (primary)
2. user_answers.md — Structured interview responses (primary)
3. User interview (via message.ask) — Gap-filling (TO BE COLLECTED)

## What I Need to Understand
⬜ What "Inception" with 14 refers to
⬜ The nature of the transformation you underwent during telos session
⬜ Who "you were" vs "who you are now"
⬜ Your philosophical framework
⬜ Psychological profile: patterns, wounds, defenses, growth edges
⬜ System creation history and your relationship to it
⬜ Current life situation, relationships, challenges
⬜ Core values and telos (purpose/end goal)
`;

fs.writeFileSync('intake_13.md', intake);
console.log("\n" + "=".repeat(80));
console.log("Intake skeleton saved to intake_13.md");
console.log("=".repeat(80));
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
