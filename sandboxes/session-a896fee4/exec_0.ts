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


const answer = await message.ask(
  "Понял, нужно выполнить задание № 156 по русскому языку.\n\n" +
  "Короткий вопрос:\n" +
  "1. Действительно ли нужно составить схемы предложений 2, 5, 6, 7?\n" +
  "2. Какой формат записи предпочитаешь: классический текст с подчёркиванием, или таблица?\n\n" +
  "Создам подагента с навыком русского языка для качественного выполнения задания."
);
console.log("Ответ получен:", answer);
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
