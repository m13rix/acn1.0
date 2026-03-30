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
console.log('Исследую OpenClaw и критерии школьной работы последовательно и сохраняю результаты.');

const openclaw = await search.research(
  'OpenClaw agentic framework architecture provider tools code as action heartbeat comparison',
  { stream: false }
);
fs.writeFileSync('./openclaw_research.md', openclaw.output || 'NO_OUTPUT', 'utf8');
console.log('Saved openclaw_research.md');
console.log((openclaw.output || '').slice(0, 3000));

const school = await search.research(
  'критерии индивидуального проекта 9 класс исследовательская работа структура актуальность проблема цель задачи объект предмет гипотеза методы новизна практическая значимость Краснодарский край',
  { stream: false }
);
fs.writeFileSync('./school_project_criteria.md', school.output || 'NO_OUTPUT', 'utf8');
console.log('Saved school_project_criteria.md');
console.log((school.output || '').slice(0, 3000));
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
