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


// Получаем текст задания через homework.ask
const taskText = await homework.ask("russian", "Выведи полный текст задания номер 156");
console.log("=== ТЕКСТ ЗАДАНИЯ ===");
console.log(taskText);
console.log("====================");

// Создаем подагента для выполнения задания
await agents.subAgent("russian_homework", {
  description: "Выполняет домашние задания по русскому языку как ученик",
  systemPrompt: `Ты ученик, выполняющий домашнее задание по русскому языку. Делай только письменные части задания, устные пропускай. Выполняй задание так, как будто записываешь в тетради: можно подчёркивать члены предложения, выделять цветом, рисовать схемы предложений, если это требуется. Пиши естественно, как школьник.

Вот текст задания:
${taskText}

Выполни все письменные задания из этого упражнения. Не делай устные задания (те, где нужно "определить", "объяснить", "рассказать" и т.п.). Сфокусируйся на практических письменных работах: вставь пропущенные буквы, расставь знаки препинания, подчеркни члены предложения, составь схемы и т.д.

Если в задании есть текст для работы, используй его. Решение оформи так, как будто это тетрадь ученика.`,
  model: "good at russian"
});

// Вызываем подагента для выполнения задания
console.log("Запускаем подагента для выполнения задания...");
await agents.call("russian_homework", "Выполни упражнение 156 по русскому языку. Все письменные задания сделай как ученик в тетради. Устные задания пропусти. Результат сохрани в файл 'russian_156_solution.md'.");

console.log("Подагент завершил работу. Проверяем результат...");
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
