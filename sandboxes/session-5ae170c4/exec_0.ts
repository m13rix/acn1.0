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
  "Привет! Я готов помочь с заданием по биологии про адаптации.\n\n" +
  "Прежде чем начать, уточню несколько моментов:\n\n" +
  "1. Вы хотите, чтобы я собрал примеры адаптаций самостоятельно (используя поиск и исследовательские возможности), или у вас уже есть конкретные источники/учебник, откуда нужно взять информацию?\n\n" +
  "2. Нужно ли разделять примеры по типам адаптаций (биологические, физиологические, морфологические, поведенческие) в отдельные разделы внутри .md файла?\n\n" +
  "3. Какой объём примерно нужен? Например, по 3-5 примеров на каждый тип или больше?\n\n" +
  "4. Есть ли какие-то особые требования к оформлению (например, нужно ли добавлять изображения, схемы, ссылки)?\n\n" +
  "После уточнения я предложу план действий и приступлю к выполнению."
);

console.log(answer);
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
