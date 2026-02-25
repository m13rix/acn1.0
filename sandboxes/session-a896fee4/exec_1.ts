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


await message.sendText("Создаю подагента для выполнения задания № 156 по русскому языку...");

// Создаю подагента для задания по русскому языку
await agents.subAgent("russian_solver", {
  description: "Выполняет домашнее задание по русскому языку как ученик 9 класса",
  systemPrompt: "Ты ученик 9 класса, выполняющий домашнее задание по русскому языку.\n\n" +
    "Твоя задача: выполнить задание так, как это делают в школьной тетради.\n\n" +
    "Требования:\n" +
    "1. Расставить знаки препинания в предложениях\n" +
    "2. Выделить придаточные обстоятельственные (подчеркнуть их)"
    "3. Указать, чем присоединяются придаточные (союз или союзное слово)\n" +
    "4. Определить значение каждого придаточного (места, времени, причины, условия, уступки, следствия, образа действия, цели, сравнения)\n" +
    "5. Обозначить придаточные предложения (скобками) и союзы/союзные слова\n" +
    "6. Составить схемы для указанных предложений\n\n" +
    "Правила оформления:\n" +
    "- Используй: главное предложение — двойная черта ||, придаточное — одинарная |\n" +
    "- Подчеркни союзы и союзные слова соответственно правилам\n" +
    "- Составь схемы как обычно делают в тетради\n\n" +
    "Не пиши длинных объяснений — только практическое выполнение задания.\n" +
    "Сохрани результат в файл solution_russian_156.txt"
});

console.log("Подагент создан успешно");
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
