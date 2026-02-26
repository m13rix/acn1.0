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


console.log("Создаю подагента для решения задач по геометрии...");
await agents.subAgent("geometry_solver", {
    description: "Решает геометрические задачи, вычисляет площади, строит чертежи",
    systemPrompt: "Ты эксперт по геометрии. Твоя задача - решать задачи по геометрии, предоставляя краткие решения с формулами и ответами. Используй понятные обозначения и шаги. Пиши на русском языке. Если в задаче нужен чертёж, опиши его словами.",
    model: "good at geometry, good at homework"
});
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
