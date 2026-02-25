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


FINISH("✅ Задача 'auto_homework' успешно создана!\n\nТеперь при добавлении новой заметки в OneNote:\n1️⃣ Система проверит, является ли она домашним заданием (через LLM-анализ)\n2️⃣ Если да — автоматически запустит выполнение с текстом заметки\n3️⃣ Выполнит задание используя все доступные инструменты\n\nЗадача настроена на бесконечное повторение и уже активна. Можно протестировать, создав заметку в OneNote с текстом типа «русский - упражнение 262» или «ДЗ по алгебре: задача 156».");
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
