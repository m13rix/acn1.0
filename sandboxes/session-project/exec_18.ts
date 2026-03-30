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


console.log('Пишу главу об архитектуре и эволюции TELOS через подагента.');
await agents.call('research_writer', `
Нужно написать ТОЛЬКО вторую главу новой исследовательской работы на русском языке и сохранить в файл ./section_chapter2_telos.md

Используй материалы из файлов:
- ./new_project_blueprint.md
- ./system_architecture_report.md
- ./old_project_analysis.md
- ./author_interview_round2.json
- ./final_clarifications.json
- ./notes_srcAgent_architecture.md
- ./notes_srcAgent_deep_dive.md
- ./section_introduction.md
- ./section_chapter1_theory.md

Нужная структура главы:
# Глава 2. Архитектура и эволюция системы TELOS
## 2.1. История развития проекта и смена архитектурных этапов
## 2.2. Provider tools и принцип code-as-action
## 2.3. Песочница, терминал, файловая система и расширяемость среды
## 2.4. Оркестрация агентов, подагентов и специализированных модулей
## 2.5. Skills, заметки, память и сохранение контекста
## 2.6. Heartbeat как механизм проактивности и автоматизации
## 2.7. Strategy, realtime, homework, srcAgent и другие прикладные контуры
## Выводы по второй главе

Требования:
- это должна быть одна из самых сильных глав всей работы;
- покажи эволюцию от старой системы к новой;
- сохрани научную осторожность: что подтверждено, что интерпретируется, что перспективно;
- graph memory опиши как интересное перспективное направление, а не как доказанно лучший стандарт;
- не перегружай бессмысленным жаргоном, но текст должен быть по-настоящему сильный;
- делай акцент на TELOS, а не на старом названии ACN, упоминая ACN лишь как предыдущий этап/название при необходимости.

Сохрани только готовую главу в ./section_chapter2_telos.md
`);
console.log('section_chapter2_telos done');
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
