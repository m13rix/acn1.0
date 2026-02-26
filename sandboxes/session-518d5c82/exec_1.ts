require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const homework = require('../../tools/homework/index.ts');

// Agent code execution
(async () => {
// Package requires


const answer = await message.ask("Уточните, пожалуйста:\n1. Задачи 557 и 559 из учебника геометрии (bookId 'geometry') или всё же из алгебры ('algebra')?\n2. Нужно ли оформить обе задачи в одном файле или отдельно?\n3. Какой уровень подробности решения нужен: краткое решение с ответом или развёрнутое с пояснениями?\n\nЯ готов получить текст заданий через homework.ask и начать работу.");
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
