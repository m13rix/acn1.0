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
  "Несколько уточняющих вопросов перед тем, как я начну глубокое исследование:\n\n" +
  "1. **Глубина академичности**: Вам нужны сухие научные данные (цитаты из PubMed/APA) или синтез \"наука + философия\", более эссеистичный и применимый к реальной жизни подростка?\n" +
  "2. **Формат вывода**: Хотите ли вы, чтобы я сначала просто собрал сырые данные, или сразу структурировал это как *психологический профиль-анализ* (феномен -> проявление у Максима)?\n\n" +
  "Мой план действий:\n" +
  "1. Запущу researcher по 5 ключевым направлениям.\n" +
  "2. Синтезирую это в research_domain_13.md, напрямую связывая с фактами из профиля.\n" +
  "3. Выделю \"Красные флаги\" vs \"Норма кризиса взросления\"."
);
console.log("User answer:", answer);
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
