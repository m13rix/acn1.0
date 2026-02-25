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


// Задаю уточняющие вопросы перед началом
const answer = await message.ask(
  "Отлично, я готов научиться выполнять домашнее задание! Прежде чем начать, уточню несколько важных моментов.\n\n" +
  "1. **Предметы:** Я вижу, что homework.ask поддерживает bookId: 'algebra', 'geometry', 'social_studies', 'history', 'russian'. " +
  "Как мне определять предмет по вашему запросу? Только по явному указанию (например, 'русский язык' → 'russian', 'геометрия' → 'geometry') или могут быть синонимы?\n\n" +
  "2. **Формат запроса:** Вы привели пример 'Выполни домашнее задание: русский язык, упражнение 156'. " +
  "Могут ли быть другие формулировки, например 'Сделай домашку по алгебре номер 42'? " +
  "Нужно ли мне парсить запрос или вы всегда будете использовать такой шаблон?\n\n" +
  "3. **Геометрия:** Как определять, что задача по геометрии? По bookId 'geometry' или анализировать текст задания? " +
  "Если по bookId, то я буду вызывать generateSVG только для geometry. Если по содержанию, то нужны критерии.\n\n" +
  "4. **Файлы:** Где сохранять промежуточные файлы (текст задания, решение)? " +
  "Есть ли предпочтения по именованию, например 'task_156.txt', 'solution_156.md'?\n\n" +
  "5. **Показ задания:** Нужно ли показывать вам текст задания перед выполнением для подтверждения?\n\n" +
  "6. **Подагенты:** Какую модель использовать для подагентов? " +
  "Вы советуете специализироваться на конкретной задаче — стоит ли создавать разных подагентов для разных предметов (математика, русский, история) или одного универсального?\n\n" +
  "7. **Валидация:** Нужно ли как-то проверять решение перед форматированием (например, вами или другим агентом)?\n\n" +
  "8. **Финальный файл:** homework.formatHomework сохраняет в .txt. Это подходящий формат? " +
  "Нужно ли скидывать только файл или также текстовое описание результата?\n\n" +
  "Пожалуйста, ответьте на эти вопросы, чтобы я мог сделать всё максимально качественно."
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
