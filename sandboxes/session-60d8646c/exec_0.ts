require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


const answer = await message.ask(
  "Отлично! Я вижу у вас есть Excel файл с двумя приложениями. Вы хотите:\n\n" +
  "1. Просто посчитать сумму в ячейке R1038C8 для столбца 8 (H) в листе 'Приложение 1'?\n" +
  "2. Или вы хотите, чтобы я научился работать с Excel файлами в целом, чтобы в будущем вы могли давать подобные задачи?\n\n" +
  "Если второе — я могу создать полноценный инструмент для работы с Excel, который будет уметь:\n" +
  "- Читать файлы .xlsx/.xls\n" +
  "- Находить листы и ячейки по названию/координатам\n" +
  "- Выполнять вычисления (суммы, средние и т.д.)\n" +
  "- Сохранять изменения обратно в файл\n" +
  "- И многое другое\n\n" +
  "Также уточните: нужно ли сохранять изменения в исходный файл или создать новый? И нужно ли автоматически вычислять сумму для всех подобных случаев (например, если есть другие 'Всего по позициям:' в других столбцах/листах)?"
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
