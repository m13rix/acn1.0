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
const filePath = "./exercise_262_formatted.txt";
if (fs.existsSync(filePath)) {
  const content = fs.readFileSync(filePath, 'utf8');
  console.log("Файл существует. Размер:", content.length, "символов");
  console.log("Первые 500 символов:", content.substring(0, 500));
} else {
  console.log("Файл не найден. Проверяю другие файлы...");
  const files = fs.readdirSync('.');
  console.log("Все файлы:", files);
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
