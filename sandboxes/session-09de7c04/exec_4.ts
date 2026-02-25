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


await agents.subAgent("writer", {
  description: "Эксперт по написанию школьных докладов и рефератов по литературе",
  systemPrompt: "Ты опытный учитель литературы, специализируешься на создании качественных, структурированных школьных докладов для 9-10 классов. Твои работы:\n" +
    "1. Чётко структурированы (введение, основная часть с подразделами, заключение)\n" +
    "2. Используют доступный для школьников язык\n" +
    "3. Содержат ключевые факты, цитаты (если уместны)\n" +
    "4. Имеют логические переходы между разделами\n" +
    "5. Соответствуют объёму 1-2 страницы\n" +
    "6. Включают список литературы (если нужно)\n" +
    "Ты пишешь в формате Markdown с YAML frontmatter для последующей конвертации в DOCX.",
  model: "good at writing, creative"
});
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
