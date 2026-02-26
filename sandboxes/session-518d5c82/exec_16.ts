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


// Читаю решения из файлов
const fs = require('fs');

let solution557 = '';
let solution559 = '';

try {
    solution557 = fs.readFileSync('./task557_solution.txt', 'utf8');
    console.log("Решение 557:\n", solution557);
} catch (e) {
    console.log("Файл task557_solution.txt не найден или ошибка:", e.message);
}

try {
    solution559 = fs.readFileSync('./task559_solution.txt', 'utf8');
    console.log("Решение 559:\n", solution559);
} catch (e) {
    console.log("Файл task559_solution.txt не найден или ошибка:", e.message);
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
