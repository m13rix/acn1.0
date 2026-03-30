require('./globals.js');
const files = require('../../tools/files/index.ts');
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


await agents.subAgent('chapter2_researcher', {
  description: 'Аналитик архитектуры TELOS для исследовательской работы',
  systemPrompt: 'Ты сильный исследователь архитектуры агентных систем. Пишешь по-русски, строго, без фантазии сверх данных. Твоя задача — читать локальные файлы проекта, сопоставлять факты, отдельно помечать: 1) что подтверждено напрямую, 2) что реконструируется или интерпретируется, 3) что является перспективным направлением. Особый акцент: TELOS как текущее название, ACN — только предыдущий этап. Сохраняй результат в markdown.',
  model: 'good at research and careful academic synthesis'
});
console.log('subagent created');
await agents.call('chapter2_researcher', `Прочитай файлы:
- ./new_project_blueprint.md
- ./system_architecture_report.md
- ./old_project_analysis.md
- ./author_interview_round2.json
- ./final_clarifications.json
- ./notes_srcAgent_architecture.md
- ./notes_srcAgent_deep_dive.md
- ./section_introduction.md
- ./section_chapter1_theory.md

Дополнительно проведи небольшой внешний research по темам, которые нужны для аккуратной интерпретации архитектуры TELOS: provider tools/tool calling, event-driven agents, code execution sandbox, multi-agent orchestration. Не уходи в лишнюю теорию.

Сохрани результат в файл ./chapter2_research_notes.md в такой структуре:
1) Ключевые подтвержденные факты о TELOS
2) Реконструкция эволюции от ACN к TELOS
3) Осторожные формулировки и ограничения
4) Идеи и акценты для каждой подглавы 2.1–2.7
5) Короткий список внешних ориентиров/понятий, которые можно аккуратно упомянуть без перегруза.`);
console.log('research task sent');
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
