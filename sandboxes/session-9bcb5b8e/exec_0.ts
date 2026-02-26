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
  "Перед выполнением задания по биологии уточню несколько моментов:\n\n" +
  "1. Есть ли конкретный учебник или параграф, на который нужно опираться? Например, учебник Биология 9 класс, автор... Или задание общее?\n" +
  "2. Сколько примерно примеров нужно в каждом типе адаптаций? (например, по 3-5 или как можно больше)\n" +
  "3. Нужно ли давать определения типов адаптаций (биологические, физиологические, морфологические, поведенческие) перед примерами?\n" +
  "4. Какой стиль изложения предпочтительнее: научно-популярный для 9 класса или более строгий академический?\n" +
  "5. Нужно ли добавлять изображения (например, схемы) или только текстовые примеры?\n" +
  "\n" +
  "От этого зависит качество результата."
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
