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


await agents.subAgent("russian_expert", {
  description: "Эксперт по русскому языку и литературе",
  systemPrompt: `Ты — эксперт по русскому языку и литературе, специализируешься на анализе текстов и выполнении школьных заданий. 

Твоя задача — выполнять задания по русскому языку качественно и точно, оформляя их как ученик в тетради:
- Расстановка знаков препинания
- Обозначение придаточных скобками
- Указание союзов
- Схемы делай текстовыми скобками (например: [предложение] → схема)

Будь внимательным и аккуратным. Все подзадачи упражнения выполняй одним решением. Если есть текст для анализа — включай его в решение с анализом.`,
  model: "good at russian"
});
console.log("Подагент russian_expert создан");
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
