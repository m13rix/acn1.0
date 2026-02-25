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


const answer = await message.ask(
  "Отлично! Давай настрою процесс выполнения домашних заданий. Чтобы всё было максимально качественно, уточни несколько моментов:\n\n" +
  "1. **Подагенты**: Создавать постоянного специализированного агента для домашних заданий, или каждый раз нового?\n" +
  "2. **Формат вывода**: homework.formatHomework создаёт .txt файл. Нужно ли дополнительно конвертировать в PDF/DOCX?\n" +
  "3. **Автоматизация**: Всегда спрашивать тебя перед каждым шагом, или действовать автономно по описанному алгоритму?\n" +
  "4. **Сложные задания**: Если в упражнении несколько подзадач (а, б, в) — обрабатывать всё одним решением или разбивать?\n" +
  "5. **Проверка**: Проверять ли решение подагента на правильность, или доверять ему?\n" +
  "6. **Структура**: Нужны ли заголовки, пояснения, или просто чистое решение?\n" +
  "7. **Рисунки (геометрия)**: Всегда генерировать SVG, или только если явно требуется?\n" +
  "8. **Промежуточные файлы**: Сохранять ли текст задания, .md решение, SVG, или только итоговый .txt?\n" +
  "9. **Уведомления**: Сообщать о каждом этапе (получил задание, создал агента и т.д.)?\n\n" +
  "Ответь кратко по пунктам — так я точно пойму твои предпочтения."
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
