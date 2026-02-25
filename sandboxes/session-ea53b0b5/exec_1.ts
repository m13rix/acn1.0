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


const answer = await message.ask(
  "Отлично! У меня есть сенсор notes для Microsoft OneNote.\n\n" +
  "План создания задачи:\n" +
  "1. Создам heartbeat задачу с триггером `heartbeat.sensors.notes.events.newNote()`\n" +
  "2. Добавлю условие (condition), которое будет проверять, содержит ли текст заметки признаки домашнего задания\n" +
  "3. При срабатывании буду выполнять домашнее задание через homework API\n\n" +
  "Уточняющие вопросы:\n" +
  "1. Как точно определять домашнее задание? Например, по ключевым словам ('упражнение', 'задание', 'домашнее', 'задача') или по паттерну 'предмет - номер' (например, 'русский - упражнение 262')?\n" +
  "2. Нужно ли также обрабатывать изменения существующих заметок или только новые?\n" +
  "3. Хотите ли вы ограничить количество повторений (например, только один раз или бесконечно)?\n" +
  "4. Нужно ли как-то фильтровать заметки по папкам/разделам OneNote?\n" +
  "5. Какой именно формат запроса предпочитаете? Просто 'Выполни домашнее задание: {{текст}}' или добавить дополнительные инструкции?"
);
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
