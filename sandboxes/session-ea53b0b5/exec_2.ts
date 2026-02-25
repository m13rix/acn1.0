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


// Создаем heartbeat задачу для автоматического выполнения домашних заданий
const result = await heartbeat.tasks.create("auto_homework", {
  trigger: `heartbeat.sensors.notes.events.newNote()`,
  condition: `heartbeat.sensors.ask("notes", "Эта заметка выглядит как домашнее задание? Она может содержать названия предметов (русский, математика, алгебра, геометрия, история, обществознание, физика, химия, биология, английский), номера упражнений, задачи, слова 'дз', 'домашнее задание', 'упражнение', 'конспект', 'презентация', 'сообщение', 'параграф'. Отвечай только 'да' или 'нет'.") === "да"`,
  action: `Выполни домашнее задание: {{exact_note_text}}`,
  maxRepeats: -1  // бесконечно
});

console.log("Задача создана:", result);

// Проверим список задач
const tasks = await heartbeat.tasks.list();
console.log("Список задач после создания:", tasks);
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
