require('./globals.js');
const files = require('../../tools/files/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const utils = require('../../tools/utils/index.ts');

// Agent code execution
(async () => {
// Package requires


await file.write('result.txt', 'Это тестовый текстовый файл.');
await message.sendFile('result.txt', 'Вот твой файл!');
console.log('Файл создан и отправлен');
})().then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(async err => {
  console.error(err);
  process.exitCode = 1;
  await new Promise(resolve => setTimeout(resolve, 200));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exitCode = 1;
});
