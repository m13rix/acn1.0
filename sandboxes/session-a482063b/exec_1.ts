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
  "Я получил информацию о задании 156 по русскому языку, но полного текста задания в источниках нет.\n\n" +
  "Известно, что задание 155 связано с таблицей видов обстоятельственных придаточных предложений, союзов, союзных слов и примеров.\n" +
  "Задание 156, вероятно, продолжает эту тему (сложноподчинённые предложения с обстоятельственными придаточными).\n\n" +
  "Как вы хотите поступить?\n\n" +
  "Варианты:\n" +
  "1. Попробовать найти похожие задания на эту тему и выполнить их (я могу создать подагента-эксперта по русскому языку).\n" +
  "2. Вы можете предоставить точный текст задания из своего учебника (сфотографировать или набрать).\n" +
  "3. Я могу выполнить задание на основе типичных упражнений по этой теме.\n\n" +
  "Что вы предпочитаете?"
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
