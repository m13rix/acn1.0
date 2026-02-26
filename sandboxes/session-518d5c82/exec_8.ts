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


const task559 = "Определить площадь круга радиуса 5 см";
console.log("Вызываю подагента для решения задачи 559...");
await agents.call("geometry_solver", `Реши задачу 559: "${task559}"
Требования:
- Краткое решение с формулами
- Ответ в виде числа с единицами измерения
- Если нужен чертёж, опиши его
- Сохрани решение в файл task559_solution.txt`);
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
