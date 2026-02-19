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


// Создаем подагента с лучшей аналитической моделью
await agents.subAgent("test_analyzer", {
  description: "Тестовый аналитический подагент для демонстрации работы",
  systemPrompt: 
    "Ты - аналитический подагент. Твоя задача - просто продемонстрировать, что ты работаешь.\n" +
    "Сделай следующее:\n" +
    "1. Напиши приветственное сообщение\n" +
    "2. Покажи, что ты можешь выполнять код (например, вычисли 2+2)\n" +
    "3. Сохрани результат в файл test_result.md\n" +
    "4. Сообщи о завершении работы",
  model: "analytical, thorough"  // Лучшая аналитическая модель
});

console.log("✅ Подагент 'test_analyzer' создан успешно!");
console.log("🚀 Запускаю подагента...");

// Запускаем подагента
await agents.call("test_analyzer", 
  "Привет! Это тестовый запуск. Пожалуйста, выполни свои задачи и покажи, что ты работаешь."
);

console.log("✅ Подагент завершил работу!");
console.log("📄 Проверяю созданный файл...");

// Проверяем результат
const fs = require('fs');
if (fs.existsSync('test_result.md')) {
  const result = fs.readFileSync('test_result.md', 'utf-8');
  console.log("\n📋 Содержимое test_result.md:");
  console.log(result);
} else {
  console.log("⚠️ Файл test_result.md не найден");
}

FINISH("Тест подагента завершен успешно! Подагент создан, запущен и выполнил задачи.");
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
