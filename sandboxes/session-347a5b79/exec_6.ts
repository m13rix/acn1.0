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
  "Подагент выполнил упражнение 156. Вот что получилось:\n\n" +
  "1. Расставлены знаки препинания\n" +
  "2. Придаточные выделены скобками\n" +
  "3. Указаны союзы/союзные слова\n" +
  "4. Составлены схемы для предложений 2, 5-7\n\n" +
  "Устную часть (определение значений) мы пропустили, как вы просили.\n\n" +
  "Результат сохранён в exercise_156_raw.txt\n\n" +
  "Вопросы:\n" +
  "1. Вас устраивает такое оформление?\n" +
  "2. Нужно ли дополнительно обозначить подчёркивания (например, '[подчёркиваем это]')?\n" +
  "3. Форматировать через homework.formatHomework или оставить как есть?"
);
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
