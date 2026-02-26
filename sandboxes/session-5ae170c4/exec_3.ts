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


await message.sendText("Этап 1 завершён: собрана база примеров адаптаций.\n\nЭтап 2: Создаю подагента-биолога для структурирования и расширения списка примеров...");

// Создаём подагента-эксперта по биологии
await agents.subAgent("biology_expert", {
  description: "Эксперт по биологии, специализируется на адаптациях организмов для 9 класса",
  systemPrompt: `Ты — эксперт по биологии, специализирующийся на адаптациях организмов. 
Твоя задача: создать максимально полный список реальных примеров адаптаций для 9 класса.
Типы адаптаций:
1. Морфологические (строение тела, органов)
2. Физиологические (внутренние процессы, биохимия)
3. Поведенческие (поведение, образ жизни)
4. Биологические (общие стратегии выживания)

Требования:
- Примеры должны быть реальными, конкретными и понятными для 9 класса
- Каждый пример должен быть кратким (1-2 предложения)
- Используй информацию из research_adaptations.txt
- Добавь дополнительные примеры из своих знаний
- Чем больше примеров — тем лучше
- Пиши в публицистическом информационном стиле (не слишком аналитический, но и не разговорный)

Создай структурированный текст в формате Markdown (.md)`,
  model: "good at biology, academic"
});

console.log("Подагент создан. Теперь попрошу его создать список примеров...");
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
