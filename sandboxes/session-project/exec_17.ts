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


console.log('Пишу теоретическую главу новой работы через подагента.');
await agents.call('research_writer', `
Нужно написать ТОЛЬКО теоретическую главу новой исследовательской работы на русском языке и сохранить в файл ./section_chapter1_theory.md

Используй материалы из файлов:
- ./new_project_blueprint.md
- ./system_architecture_report.md
- ./old_project_analysis.md
- ./author_interview_round2.json
- ./final_clarifications.json
- ./school_project_criteria.md
- ./openclaw_research.md

Нужная структура главы:
# Глава 1. Теоретические основы современных агентных LLM-систем
## 1.1. От чат-ботов к агентным системам
## 1.2. Ограничения традиционных подходов: ReAct, жёсткое tool calling, статическая оркестрация
## 1.3. Почему современной агентной системе нужна среда исполнения, память и событийность
## 1.4. OpenClaw как ориентир развития агентных фреймворков
## Выводы по первой главе

Требования:
- высокий научный уровень, ясность, хорошая логика;
- не копируй старую работу, а перепиши заново, актуально;
- OpenClaw сравнивай аккуратно и честно;
- не выдавай недоказуемые вещи за факты;
- делай переходы между подразделами естественными;
- объем нормальный для большой главы.

Сохрани только готовую главу в ./section_chapter1_theory.md
`);
console.log('section_chapter1_theory done');
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
