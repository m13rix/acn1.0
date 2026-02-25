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


console.log("Создаю подагента-эксперта по алгебре для решения задания...");
await agents.subAgent("algebra_solver", {
  description: "Эксперт по алгебре, решающий задачи по арифметическим прогрессиям",
  systemPrompt: "Ты эксперт по математике, специализирующийся на алгебре и арифметических прогрессиях. Ты должен решать задачи максимально подробно и понятно для ученика. Все вычисления показывай по шагам. Форматируй ответ в стиле ученической тетради. Дано: a₇ = 8 и a₁₁ = 12,8. Найти a₁ и d.",
  model: "good at homework"
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
