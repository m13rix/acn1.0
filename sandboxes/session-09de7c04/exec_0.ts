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
  "Получил ваше задание по литературе: создать сообщение/документ по роману «Герой нашего времени» (история создания, тема, идея, проблематика, сюжет и композиция).\n\n" +
  "Прежде чем начать, уточните несколько деталей:\n\n" +
  "1. **Стиль и объём:** Это школьный доклад (например, для 9-10 класса) или более серьёзная работа (студенческий реферат)? Какой примерно объём — 1-2 страницы или больше?\n" +
  "2. **Источники:** Хотите, чтобы я использовал актуальные литературоведческие источники (научные статьи, критика) или достаточно школьного учебника/базовых материалов?\n" +
  "3. **Структура:** Нужно ли придерживаться какой-то конкретной структуры (например, введение, основные главы, заключение) или вы доверяете мне организовать материал оптимально?\n" +
  "4. **Формат:** Документ должен быть в формате Word (.docx) или подойдёт Markdown/PDF?\n\n" +
  "После уточнения я проведу исследование, соберу информацию и оформлю качественный документ."
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
