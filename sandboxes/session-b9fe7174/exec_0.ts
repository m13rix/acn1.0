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


// Получаем текст задания упражнения 156 из учебника русского языка
const taskText = await homework.ask("russian", "Выведи ПОЛНОЦЕННЫЙ ТЕКСТ ЗАДАНИЯ номер 156 в этом учебнике. ПОЛНЫЙ ТЕКСТ ЗАДАНИЯ, а также текста или т.п. по которому нужно сделать задание");
console.log("Текст задания получен:");
console.log(taskText);

// Теперь спрашиваем пользователя
const answer = await message.ask(
  "Я получил текст задания упражнения 156 по русскому языку. Вот оно:\n\n" +
  taskText + "\n\n" +
  "Хотите, чтобы я выполнил это задание? Если да, я создам подагента-специалиста по русскому языку, который выполнит все подзадачи одним решением, а затем отформатирую и отправлю вам файл."
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
