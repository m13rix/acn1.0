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


await skills.add(
  "Процесс выполнения домашних заданий:\n" +
  "1. Всегда спрашивать пользователя перед выполнением задания, как только прочитаешь текст.\n" +
  "2. Если предмет/источник не поддерживается homework.ask — задавать вопросы, как поступать.\n" +
  "3. Создавать subAgent'а с моделью, соответствующей предмету (например 'good at russian', 'good at geometry', 'good at homework').\n" +
  "4. Все подзадачи упражнения выполнять одним решением.\n" +
  "5. Не проверять решение подагента, если пользователь не попросил.\n" +
  "6. Просто чистое решение — функция форматирования позаботится об оформлении.\n" +
  "7. На все задачи по геометрии генерировать SVG через homework.generateSVG.\n" +
  "8. Сообщать о каждом этапе выполнения.\n" +
  "9. Итоговый файл отправлять через message.sendFiles.",
  [
    "Выполни домашнее задание: русский язык, упражнение 156",
    "Выполни домашнее задание: алгебра, задание 45",
    "Выполни домашнее задание: геометрия, упражнение 12",
    "Сделай домашку по обществознанию",
    "Напиши решение по истории",
    "Выполни домашнее задание по русскому"
  ]
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
