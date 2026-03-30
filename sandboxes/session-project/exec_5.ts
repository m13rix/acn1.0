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


await agents.call('researcher', [
  'Кратко изучи внешний контекст по OpenClaw / OpenCode и похожим open-source агентным фреймворкам,',
  'но только в объёме, который помогает сравнить архитектурные принципы с текущей системой.',
  'Нужны именно сравнения высокого уровня: execution model, tools/provider tools, memory, event-driven/proactivity, self-modification/working with code.',
  'Не пиши длинный обзор. Сохрани результат в файл ./external_frameworks_context.md в markdown.',
  'Отделяй проверенные факты от осторожных интерпретаций.'
].join(' '));
console.log('researcher called');
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
