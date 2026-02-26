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


// Просим подагента создать структурированный список примеров
await agents.call("biology_expert", `
Используй информацию из файла research_adaptations.txt и свои знания, чтобы создать максимально полный список примеров адаптаций для 9 класса.

Структура файла .md:

# Примеры адаптаций в биологии (9 класс)

## Морфологические адаптации
(Примеры с кратким описанием)

## Физиологические адаптации
(Примеры с кратким описанием)

## Поведенческие адаптации
(Примеры с кратким описанием)

## Биологические адаптации (общие стратегии)
(Примеры с кратким описанием)

Требования:
- Минимум 15-20 примеров в каждом разделе (чем больше — тем лучше)
- Каждый пример должен быть реальным и понятным для 9 класса
- Формат: кратко, информативно, публицистический стиль
- Сохрани результат в файл biology_adaptations.md
`);

console.log("Запрос отправлен подагенту. Ожидаю результат...");
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
