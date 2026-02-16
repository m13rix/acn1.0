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
  "Хорошо, помогу с картинками для презентации. Уточню несколько моментов:\n\n" +
  "1. **Количество картинок**: Сколько примерно изображений вам нужно? 5-10 или больше?\n\n" +
  "2. **Темы и стиль**: Какие именно изображения вы бы хотели?\n" +
  "   • Юридические символы (весы правосудия, законы, документы)\n" +
  "   • Подростки за работой/предпринимательством\n" +
  "   • Суды, органы опеки, государственные учреждения\n" +
  "   • Абстрактные концепции свободы, ответственности\n" +
  "   • Инфографика или схемы по эмансипации\n" +
  "   • Иллюстрации из российского контекста\n\n" +
  "3. **Качество и формат**: Нужны ли изображения определённого разрешения или формата (например, для слайдов 16:9)?\n\n" +
  "4. **Поиск**: У вас есть ограничения по использованию imageSearch? Вы упомянули, что research не работает, но imageSearch может быть доступен."
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
