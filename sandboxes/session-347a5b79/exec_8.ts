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


console.log("Отправляем файл пользователю...");
await message.sendFiles(["./упражнение_156_форматированное.txt"]);

console.log("Задание выполнено! Можно запомнить этот процесс на будущее.");
const remember = await message.ask(
  "Всё готово! Запомню этот процесс на будущее, вы не против?\n" +
  "Под какой темой лучше сохранить — «школьные задания по русскому», «упражнения по русскому языку» или что-то своё?"
);

if (remember.toLowerCase().includes("да") || remember.toLowerCase().includes("запомни") || remember.toLowerCase().includes("конечно")) {
  await skills.add(
    "Процесс выполнения домашних заданий по русскому языку: " +
    "1. Спрашивать полный текст задания через homework.ask. " +
    "2. Создавать подагента-эксперта по русскому языку. " +
    "3. Выполнять только письменные задания, пропускать устные. " +
    "4. Оформлять как ученик в тетради: расстановка знаков препинания, обозначение придаточных скобками, указание союзов. " +
    "5. Схемы делать текстовыми скобками. " +
    "6. Форматировать через homework.formatHomework. " +
    "7. Отправлять файл через message.sendFiles.",
    ["Можешь выполнить домашнее задание: русский язык - упражнение 156", "сделай упражнение по русскому", "помоги с домашкой по русскому"]
  );
  console.log("Процесс сохранён в навыки!");
}

FINISH("Упражнение 156 выполнено и отформатировано! Файл отправлен вам. Устные задания пропущены, оформлено как ученик в тетради.");
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
