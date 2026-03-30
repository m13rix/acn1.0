require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
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
console.log('Проверяю результаты архитектурного подагента и извлекаю краткую выжимку из его файлов...');
for (const f of ['notes_srcAgent_architecture.md','notes_srcAgent_deep_dive.md','system_architecture_report.md']) {
  console.log(`FILE ${f}:`, fs.existsSync(f));
  if (fs.existsSync(f)) {
    const txt = fs.readFileSync(f, 'utf8');
    console.log(`--- START ${f} ---`);
    console.log(txt.slice(0, 5000));
    console.log(`--- END ${f} ---`);
  }
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
