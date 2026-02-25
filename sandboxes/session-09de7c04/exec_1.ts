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


await agents.call("researcher", "Проведи исследование по роману Михаила Лермонтова «Герой нашего времени» для школьного доклада (9 класс). Основные аспекты:\n" +
  "1. История создания романа (когда написан, публикация, влияние цензуры).\n" +
  "2. Тема, идея, проблематика (основные темы, идейное содержание, ключевые проблемы).\n" +
  "3. Сюжет и композиция (особенности сюжета, композиционная структура, хронология, значение).\n" +
  "4. Характеристика главного героя Печорина.\n" +
  "5. Значение романа в русской литературе.\n\n" +
  "Собери информацию из надёжных источников: учебники, энциклопедии, литературоведческие статьи. Сохрани весь материал в файл research.md в удобочитаемом формате с разделами.");
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
