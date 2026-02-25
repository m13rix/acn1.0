require('./globals.js');
const files = require('../../tools/files/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const homework = require('../../tools/homework/index.ts');

// Agent code execution
(async () => {
// Package requires


const answer = await message.ask("Я помогу с домашним заданием по алгебре, номер 585. \n\nПлан действий:\n1. Получу текст задания из учебника через homework.ask\n2. Если нужно решение — я могу:\n   - Построить пошаговое решение с объяснениями\n   - Сгенерировать графики или схемы, если это геометрическая задача\n   - Оформить решение в формате для принтера (пишущим почерком)\n\nЧто именно вам нужно?\n- Только текст задания?\n- Полное решение с объяснениями?\n- Оформление в готовый файл?\n\nТакже уточните, какой именно учебник алгебры (класс или тема), если знаете.");
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
