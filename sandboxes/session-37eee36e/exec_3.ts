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


// Получим текст задания заново
const taskText = await homework.ask('algebra', 'Выведи полный текст задания номер 585 в учебнике. ПОЛНЫЙ ТЕКСТ ЗАДАНИЯ, а также текста или т.п. по которому нужно сделать задание');
console.log('Текст задания №585:');
console.log(taskText);

// Уточним у пользователя детали перед решением
const answer = await message.ask(
  'Получил задание по алгебре №585. Вот его текст:\n\n' +
  taskText +
  '\n\nПеред решением уточните:\n' +
  '1. Нужно ли решать все подпункты задания полностью?\n' +
  '2. Какой уровень подробности решения предпочитаете (кратко или с пояснениями)?\n' +
  '3. Есть ли особые требования к оформлению?'
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
