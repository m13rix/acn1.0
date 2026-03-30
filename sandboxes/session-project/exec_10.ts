require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const notepad = require('../../tools/notepad/index.ts');
const realtime = require('../../tools/realtime/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const strategy = require('../../tools/strategy/index.ts');
const homework = require('../../tools/homework/index.ts');
const utils = require('../../tools/utils/index.ts');

// Agent code execution
(async () => {
// Package requires


console.log('Запускаю следующий последовательный этап: внешний research по OpenClaw и школьному формату.');
await agents.call('researcher', `
Проведи ПОСЛЕДОВАТЕЛЬНО два исследования и сохрани результаты в отдельные файлы.
Никакого параллелизма.

Часть 1. Исследуй OpenClaw:
- что это за агентный фреймворк/система;
- какие у него ключевые архитектурные идеи;
- чем он примечателен в контексте современных agentic systems;
- какие из его идей релевантны для сравнения с авторской системой TELOS;
- какие отличия/ограничения у такого сравнения.
Сохрани результат в ./openclaw_research.md

Часть 2. Исследуй требования и типовые критерии к школьной индивидуальной проектно-исследовательской работе для 9 класса в России, желательно с учётом практики школ/конференций/ИП в Краснодарском крае, но если точных региональных требований нет — возьми общероссийские типовые критерии.
Нужно выделить:
- обязательные структурные элементы;
- как формулируются актуальность, проблема, цель, задачи, объект, предмет, гипотеза, методы, новизна, практическая значимость;
- что обычно ценится комиссией;
- какие ошибки делают работы слишком «рекламными» или ненаучными;
- как сделать работу сильной, но правдоподобной для 9 класса.
Сохрани результат в ./school_project_criteria.md

Пиши с источниками и в сжатом, но содержательном исследовательском виде.
`);
console.log('researcher finished OpenClaw and school criteria');
})().then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(async err => {
  console.error(err);
  process.exitCode = 1;
  await new Promise(resolve => setTimeout(resolve, 200));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exitCode = 1;
});
