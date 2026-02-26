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


console.log("Запускаю глубокое исследование по адаптациям в биологии...");

const researchResult = await search.research("Примеры адаптаций в биологии: морфологические, физиологические, поведенческие, биологические. Конкретные примеры животных, растений, микроорганизмов. Адаптации к среде обитания, климату, хищникам, паразитам. Примеры для 9 класса", {
  stream: true
});

console.log("Исследование завершено.");
console.log("Результат:", researchResult.output ? "получен" : "нет");
if (researchResult.output) {
  // Сохраняем результат исследования в файл
  const fs = require('fs');
  fs.writeFileSync('./research_adaptations.txt', researchResult.output);
  console.log("Результаты исследования сохранены в research_adaptations.txt");
}
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
