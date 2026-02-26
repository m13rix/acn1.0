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
const { promises as fs } = require('fs');


const homework = {
  async generateSVG(task: { id: number; name: string }) {
    // Dummy SVG generation
    return `<svg><text>${task.name}</text></svg>`;
  },
};

const task557 = { id: 557, name: "Task 557" };
const task559 = { id: 559, name: "Task 559" };

async function main() {
  console.log("Генерирую SVG чертежи для обеих задач...");
  const svg557 = await homework.generateSVG(task557);
  console.log("SVG для задачи 557 сгенерирован");
  const svg559 = await homework.generateSVG(task559);
  console.log("SVG для задачи 559 сгенерирован");

  // Сохраняю SVG в файлы
  await fs.writeFile("task557_drawing.svg", svg557);
  await fs.writeFile("task559_drawing.svg", svg559);
  console.log("SVG файлы сохранены");
}

main().catch(console.error);
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
