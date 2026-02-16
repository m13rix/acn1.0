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
  "Отлично, помогу с текстом про эмансипацию для 9 класса по обществознанию.\n\n" +
  "Для максимального качества уточню несколько моментов:\n\n" +
  "1. **Формат и объём**: Это доклад, реферат, сообщение для устного выступления или конспект? Сколько примерно страниц/слов нужно?\n\n" +
  "2. **Стиль и глубина**: Нужен сухой учебный текст или более живой, с примерами? Должен ли он включать исторические примеры (эмансипация женщин, отмена крепостного права), правовые аспекты (эмансипация несовершеннолетних), современные тренды?\n\n" +
  "3. **Структура**: Хотите стандартные разделы: определение, история, виды, примеры, значение в современном обществе? Или что-то конкретное?\n\n" +
  "4. **Целевая аудитория**: Текст для одноклассников или для учителя? Нужно ли сделать его понятным и интересным для подростков?\n\n" +
  "5. **Дополнительно**: Нужны ли цитаты, статистика, ссылки на законы? Хотите ли вы, чтобы я включил конкретные примеры из России или мировые?\n\n" +
  "Дайте, пожалуйста, развёрнутые ответы — это поможет сделать текст именно таким, как вам нужно."
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
