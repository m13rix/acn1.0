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


console.log("Получаю текст задачи 557 через homework.ask...");
const task557 = await homework.ask("geometry", "Выведите полный текст задания номер 557.");
console.log("Задача 557:\n", task557);
console.log("\nПолучаю текст задачи 559 через homework.ask...");
const task559 = await homework.ask("geometry", "Выведите полный текст задания номер 559.");
console.log("Задача 559:\n", task559);
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
