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


// Сначала посмотрим список сенсоров через heartbeat.sensors.list()
const sensors = await heartbeat.sensors.list();
console.log("Доступные сенсоры:", JSON.stringify(sensors, null, 2));

// Также посмотрим список существующих задач
const tasks = await heartbeat.tasks.list();
console.log("\nСуществующие задачи:", JSON.stringify(tasks, null, 2));
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
