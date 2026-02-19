require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


// Создаём подагента с лучшей аналитической моделью
await agents.subAgent("test_analyst", {
  description: "Тестовый аналитический подагент",
  systemPrompt: 
    "Ты - аналитический подагент, созданный для тестирования системы.\n" +
    "Твоя задача: просто подтвердить, что ты работаешь, и выполнить простой анализ.\n" +
    "Отвечай кратко и по существу.",
  model: "analytical, thorough"  // лучшая аналитическая модель
});

console.log("✅ Подагент 'test_analyst' создан!");

// Запускаем подагента
await agents.call("test_analyst", 
  "Привет! Это тест. Просто ответь: 1) работаешь ли ты, 2) какая у тебя модель, 3) сделай мини-анализ: 2+2=?, и 4) как тебя зовут."
);

console.log("✅ Подагент успешно вызван и выполнил задачу!");

FINISH("Тест подагента завершён! Создан и запущен подагент 'test_analyst' с моделью 'analytical, thorough'.");
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
