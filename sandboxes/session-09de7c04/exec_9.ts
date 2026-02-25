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

console.log("Проверяю создание файла DOCX...");
const files = fs.readdirSync('.');
console.log("Файлы в директории:", files);

if (fs.existsSync('./report.docx')) {
  const stats = fs.statSync('./report.docx');
  console.log(`Файл report.docx успешно создан, размер: ${stats.size} байт`);
  
  // Отправлю файл пользователю
  await message.sendFiles(['./report.docx']);
} else {
  console.log("Файл report.docx не найден. Попробую другой подход...");
  
  // Попробую явно указать формат
  const { execSync } = require('child_process');
  try {
    execSync('pandoc report.md -t docx -o report.docx --metadata author="Telos (M13RIX)"');
    console.log("Команда выполнена.");
    
    if (fs.existsSync('./report.docx')) {
      const stats = fs.statSync('./report.docx');
      console.log(`Файл создан, размер: ${stats.size} байт`);
      await message.sendFiles(['./report.docx']);
    } else {
      console.log("Файл всё ещё не создан.");
    }
  } catch (error) {
    console.error("Ошибка при выполнении pandoc:", error.message);
  }
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
