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


// Сначала получим полный текст задания по алгебре номер 585
const taskText = await homework.ask("algebra", "Выведи ПОЛНОЦЕННЫЙ ТЕКСТ ЗАДАНИЯ номер 585 в этом учебнике. ПОЛНЫЙ ТЕКСТ ЗАДАНИЯ, а также текста или т.п. по которому нужно сделать задание");
console.log("Текст задания получен:");
console.log(taskText);

// Теперь спросим пользователя, готов ли он к выполнению, и уточним детали
const answer = await message.ask(
  "Я получил текст задания по алгебре №585. Вот что требуется:\n\n" +
  taskText.substring(0, 500) + (taskText.length > 500 ? "..." : "") +
  "\n\nМой план выполнения:\n" +
  "1. Создам подагента-эксперта по алгебре с моделью 'good at homework' для качественного решения.\n" +
  "2. Выполню все подзадачи одним решением (как требует навык).\n" +
  "3. Отформатирую решение через homework.formatHomework для печати.\n" +
  "4. Отправлю готовый файл вам.\n\n" +
  "Всё ли верно? Есть ли особые пожелания по стилю или оформлению? (например, нужно ли подробное объяснение, или только ответы?)"
);

console.log("Ответ пользователя:", answer);
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
