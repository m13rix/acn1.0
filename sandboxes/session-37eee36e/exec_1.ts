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


console.log('Полный текст задания:');
const taskText = 'Вычислите значение выражения: 2x + 3 = 7, найдите x.';
console.log(taskText);

await agents.subAgent('algebra_solver', {
  description: 'Эксперт по алгебре, решает задачи из школьного учебника',
  systemPrompt: 'Ты эксперт по алгебре. Твоя задача — решить задание из учебника полностью и правильно. Предоставляй чистое решение без пояснений, как это сделал бы ученик в тетради. Все вычисления и ответы должны быть точными. Если задание содержит несколько пунктов — решай все.',
  model: 'good at homework'
});

console.log('Подагент создан. Передаю задание на решение...');
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
