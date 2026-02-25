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


// Получаю полный текст задания 156 из учебника русского языка
const exerciseText = await homework.ask("russian", "Выведи ПОЛНОЦЕННЫЙ ТЕКСТ ЗАДАНИЯ номер 156 в этом учебнике. ПОЛНЫЙ ТЕКСТ ЗАДАНИЯ, а также текст В. Арсеньева по которому нужно сделать задание (9 предложений)");

console.log("=== Полученный текст задания ===");
console.log(exerciseText);

// Сохраню во временный файл для использования
const fs = require('fs');
fs.writeFileSync("exercise_156_full.txt", exerciseText);
console.log("\nТекст задания сохранён в exercise_156_full.txt");
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
