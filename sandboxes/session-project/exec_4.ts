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
const prompt = [
  'Нужен второй, более точечный архитектурный разбор системы по исходному коду.',
  'Сфокусируйся только на следующих темах и укажи, что подтверждено по коду, а что нельзя уверенно утверждать:',
  '',
  'A. Память и сохранение состояния:',
  '- skills;',
  '- notepad;',
  '- любые другие механизмы памяти, persistence, shared state, session state, файлы данных;',
  '- есть ли разграничение между кратковременной и долговременной памятью.',
  '',
  'B. Heartbeat/event-driven архитектура:',
  '- как устроены bindings и sensors;',
  '- насколько это именно event-driven proactivity, а не просто cron;',
  '- какие ограничения видны по реализации.',
  '',
  'C. Strategy system:',
  '- реальная модель данных;',
  '- что система умеет аналитически;',
  '- что говорит код о степени завершенности.',
  '',
  'D. Realtime, homework, files/view, utils, srcAgent:',
  '- для чего предназначены;',
  '- какие реальные механизмы видны по коду;',
  '- что выглядит зрелым, а что экспериментальным.',
  '',
  'E. Что из старых идей из текста проекта, вероятно, уже устарело или требует осторожной переформулировки применительно к текущей системе.',
  '',
  'Пожалуйста, ответь компактно, но содержательно, без фантазии.'
].join('\n');
const response = await srcAgent.sendRequest(prompt);
fs.writeFileSync('./notes_srcAgent_deep_dive.md', response, 'utf8');
console.log(response);
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
