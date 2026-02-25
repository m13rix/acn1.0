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
  "❓ Проблема: homework.ask не вернул текст упражнения 156. Возможно:\n" +
  "1. Такого номера нет в учебнике\n" +
  "2. Проблема с доступом к данным\n" +
  "3. Нужно уточнить запрос\n\n" +
  "Как поступить?\n" +
  "• Попробовать другой номер (например, 155 или 157)?\n" +
  "• Уточнить запрос (например, добавить 'упражнение 156 из учебника русского языка')?\n" +
  "• Использовать другой источник?\n" +
  "• Или у тебя есть точный текст задания?"
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
