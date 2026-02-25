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
    "Я готов выполнить домашнее задание по литературе на тему: 'История создания романа \"Герой нашего времени\", тема, идея, проблематика. Особое внимание обратить на сюжет и композицию'.\n\n" +
    "Несколько вопросов перед началом:\n" +
    "1. Есть ли у вас учебник или источник, откуда нужно взять полный текст задания? Если да, укажите предмет и номер задания.\n" +
    "2. Какой формат результата вам нужен? (просто текст, документ .docx, .txt, что-то ещё?)\n" +
    "3. Хотите ли вы, чтобы я использовал researcher для поиска дополнительной информации, или достаточно моих знаний и базового поиска?\n" +
    "4. Уровень детализации: кратко или максимально подробно?"
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
