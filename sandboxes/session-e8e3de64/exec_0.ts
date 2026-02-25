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
  "Я помогу с домашним заданием по алгебре. Чтобы получить полный текст задания, мне нужно уточнить:\n\n" +
  "1. Какой именно номер задания? Вы написали 'номер5 85 весь'. Это номер 5.85? Или номер 5 на странице 85? Или номер 5 и номер 85?\n" +
  "2. Какой учебник алгебры (класс)?\n" +
  "3. Нужно выполнить все подзадачи этого задания?\n\n" +
  "После уточнения я запрошу полный текст задания через систему и приступлю к решению."
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
