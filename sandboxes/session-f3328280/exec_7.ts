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


console.log("🔄 Пробуем другой запрос...");

const taskText2 = await homework.ask("russian", "Упражнение 156 из учебника русского языка. Выведи полный текст задания, включая все условия и текст для анализа.");

console.log("Результат второго запроса:");
console.log(taskText2);

if (taskText2 && taskText2.includes("Откат") || !taskText2 || taskText2.trim() === "") {
  await message.sendText("❌ Снова не удалось получить текст. Пробую третий вариант с другим bookId?");
} else {
  await message.sendText(`✅ Получил текст упражнения 156:\n\n${taskText2}\n\nНачинать выполнение?`);
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
