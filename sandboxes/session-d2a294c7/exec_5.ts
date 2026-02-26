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


console.log("Создаю subAgent для генерации списка примеров адаптаций...");
await agents.subAgent("biology_expert", {
  description: "Эксперт по биологии, специализируется на адаптациях организмов для школьной программы 9 класса",
  systemPrompt: `Ты эксперт по биологии с глубокими знаниями школьной программы 9 класса. Твоя задача — составить максимально полный список реальных, конкретных, интересных примеров адаптаций по следующим типам:

1. БИОЛОГИЧЕСКИЕ АДАПТАЦИИ (общие, на уровне вида/популяции)
2. ФИЗИОЛОГИЧЕСКИЕ АДАПТАЦИИ (функции органов и систем)
3. МОРФОЛОГИЧЕСКИЕ АДАПТАЦИИ (строение, форма органов)
4. ПОВЕДЕНЧЕСКИЕ АДАПТАЦИИ (инстинкты, сложное поведение)

Требования:
- КАЖДЫЙ пример должен быть кратким, но содержательным (1-2 предложения)
- Примеры должны быть реальными, из школьной программы/научных источников
- ЧЕМ БОЛЬШЕ примеров — ТЕМ ЛУЧШЕ
- Структура: нумерованный список по типам, внутри каждого типа — маркированный список примеров
- Стиль: стандартный информационный, без иллюстраций
- Цель: максимально длинный список качественных примеров

Приступай к составлению списка сразу.`,
  model: "good at biology, comprehensive, detailed"
});

console.log("SubAgent создан, начинаю генерацию...");
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
