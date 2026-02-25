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


await srcAgent.sendRequest(
  "Мне нужно сделать git commit текущего репозитория со всеми последними изменениями. Пожалуйста:\n" +
  "1. Добавь все изменения (git add -A)\n" +
  "2. Создай осмысленный коммит с информативным сообщением, которое отражает суть изменений\n" +
  "3. Если есть возможность, используй лучшие практики для сообщений коммитов\n" +
  "4. Выполни команду и верни результат\n" +
  "\n" +
  "Важно: добавь абсолютно все изменения, включая новые файлы, изменения и удаления."
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
