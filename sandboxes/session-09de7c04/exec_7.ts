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


const fs = require('fs');
const path = require('path');

console.log("Проверяю наличие файлов...");
const files = fs.readdirSync('.');
console.log("Текущие файлы:", files);

if (fs.existsSync('./report_basic.md')) {
  console.log("Файл report_basic.md существует.");
  const content = fs.readFileSync('./report_basic.md', 'utf8');
  console.log("Размер файла:", content.length, "символов");
} else {
  console.log("Файл report_basic.md не найден. Создам заново.");
}
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
