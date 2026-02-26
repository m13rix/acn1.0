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


await message.sendText("Отлично! Начинаю выполнение задания.\n\nПлан:\n1. Использую researcher для сбора максимального количества примеров адаптаций по всем типам.\n2. Сохраняю результаты в файл.\n3. Обрабатываю данные и создаю итоговый .md файл с множеством кратких примеров.\n4. Отправлю вам готовый файл.\n\nЭтап 1: Запускаю исследование...");
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
