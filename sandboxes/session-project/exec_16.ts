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


console.log('Пишу введение новой работы через подагента.');
await agents.call('research_writer', `
Нужно написать ТОЛЬКО раздел введения для новой исследовательской работы на русском языке и сохранить в файл ./section_introduction.md

Используй материалы из файлов:
- ./new_project_blueprint.md
- ./system_architecture_report.md
- ./old_project_analysis.md
- ./author_interview_round2.json
- ./final_clarifications.json
- ./school_project_criteria.md
- ./openclaw_research.md

Требования:
- стиль: сильная школьная исследовательская работа очень высокого уровня;
- текст должен быть научным, но не выглядеть как фальшивая публикация взрослого учёного;
- обязательно включи и красиво сформулируй: актуальность, проблема, цель, задачи, объект, предмет, гипотеза, методы исследования, научную новизну, практическую значимость;
- обязательно используй название системы TELOS (Trajectory Execution & Learning Opening System);
- можно предложить новое название самой работы в заголовке введения, если это уместно;
- не перегружай введение сверх меры, но сделай его реально сильным;
- если где-то есть спорные тезисы, формулируй осторожно.

Сохрани только готовый раздел введения без комментариев в ./section_introduction.md
`);
console.log('section_introduction done');
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
