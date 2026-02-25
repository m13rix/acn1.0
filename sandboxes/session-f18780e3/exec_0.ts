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


const answer = await message.ask("Перед выполнением упражнения 262, уточните, пожалуйста:\n\n1. Какой стиль оформления предпочтителен: стандартный школьный (дата, заголовок, номера вопросов) или более свободный?\n2. Нужно ли давать развёрнутые ответы или краткие?\n3. Стоит ли мне углубиться в исследование темы скоростного чтения для более полного ответа или достаточно анализа данного текста?");
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
