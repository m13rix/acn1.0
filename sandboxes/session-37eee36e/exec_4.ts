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


// Похоже, homework.ask вернул текст по русскому языку, а не по алгебре
// Уточню у пользователя
const answer = await message.ask(
  'Извините, кажется произошла путаница. Homework.ask вернул текст, похожий на литературное произведение, а не математическое задание.\n\n' +
  'Уточните, пожалуйста:\n' +
  '1. Это точно задание по алгебре из учебника математики?\n' +
  '2. Если да, может быть стоит попробовать другой источник или вы можете предоставить текст задания самостоятельно?\n' +
  '3. Или это действительно задание по литературе/русскому языку?'
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
