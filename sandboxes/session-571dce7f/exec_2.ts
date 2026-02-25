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


// Создаём подагента-эксперта по математике
await agents.subAgent("math_expert", {
  description: "Эксперт по алгебре и арифметическим прогрессиям",
  systemPrompt: "Ты эксперт по математике, специализирующийся на арифметических прогрессиях. Ты решаешь задачи шаг за шагом, объясняя каждый этап. Формулы записываешь в TeX-формате: $a_n = a_1 + (n-1)d$. Все вычисления выполняешь точно. Результат должен быть понятен школьнику. В конце напиши ответ: $a_1 = ...$, $d = ...$.",
  model: "good at math"
});

// Даём задание подагенту
await agents.call("math_expert", "Реши задачу по алгебре №585: «В арифметической прогрессии $a_7 = 8$ и $a_{11} = 12,8$. Найдите $a_1$ и $d$». Выполни все вычисления, запиши полное решение. Результат сохрани в файл solution.md.");
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
