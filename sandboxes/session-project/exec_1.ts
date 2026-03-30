require('./globals.js');
const files = require('../../tools/files/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const notepad = require('../../tools/notepad/index.ts');
const realtime = require('../../tools/realtime/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const strategy = require('../../tools/strategy/index.ts');
const homework = require('../../tools/homework/index.ts');
const utils = require('../../tools/utils/index.ts');

// Agent code execution
(async () => {
// Package requires


const fs = require('fs');
const path = require('path');
const filesToRead = [
  './new_project_blueprint.md',
  './system_architecture_report.md',
  './old_project_analysis.md',
  './author_interview_round2.json',
  './final_clarifications.json',
  './notes_srcAgent_architecture.md',
  './notes_srcAgent_deep_dive.md',
  './section_introduction.md',
  './section_chapter1_theory.md'
];
for (const f of filesToRead) {
  const content = fs.readFileSync(f, 'utf8');
  console.log(`===== FILE: ${f} =====\n${content.slice(0, 12000)}\n`);
  if (content.length > 12000) console.log(`[TRUNCATED, total ${content.length} chars]`);
}
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
