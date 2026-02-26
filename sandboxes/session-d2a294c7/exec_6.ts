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


console.log("Вызываю biology_expert для создания списка примеров...");
await agents.call("biology_expert", "Создай максимально длинный список реальных примеров адаптаций для 9 класса по биологии. Раздели на 4 типа: биологические, физиологические, морфологические, поведенческие. Каждый пример должен быть кратким (1-2 предложения), но информативным. Примеры должны быть разнообразными, охватывать разные группы организмов (растения, животные, микроорганизмы). Чем больше примеров — тем лучше. Результат сохрани в файл adaptations_list.md.");
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
