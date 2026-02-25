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


FINISH("Готов выполнять домашние задания по твоим правилам! Процесс сохранён, теперь я буду:\n1. Получать текст задания через homework.ask\n2. Спрашивать тебя перед выполнением\n3. Создавать subAgent'а с нужной моделью\n4. Выполнять задание\n5. Для геометрии генерировать SVG\n6. Форматировать через homework.formatHomework\n7. Отправлять тебе файл\n\nДавай первое задание для проверки!");
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
