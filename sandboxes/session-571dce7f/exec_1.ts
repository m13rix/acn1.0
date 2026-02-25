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


// Спрашиваем пользователя о деталях выполнения
const answer = await message.ask(
  "Получил текст задания по алгебре №585:\n\n" +
  "«В арифметической прогрессии $a_7 = 8$ и $a_{11} = 12,8$. Найдите $a_1$ и $d$.»\n\n" +
  "Как вы хотите выполнить это задание?\n" +
  "1. Создать подагента-эксперта по математике для решения\n" +
  "2. Полностью выполнить решение (найти a₁ и d)\n" +
  "3. Отформатировать результат в файл для принтера\n\n" +
  "Или у вас есть особые пожелания?"
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
