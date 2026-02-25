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


FINISH("Извините, возникла техническая проблема с получением текста задания. Homework.ask('algebra', '585') вернул текст, похожий на литературное произведение ('Печорин, уставший от светской жизни...'), что явно не является заданием по алгебре. Возможно, проблема с источником данных или номером задания. Для решения задачи по алгебре №585 необходим корректный текст задания. Рекомендую проверить номер задания или предоставить текст задания вручную.");
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
