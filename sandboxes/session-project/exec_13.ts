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


const fs = require('fs');
console.log('Собрал достаточно базы для перехода к проектированию новой научной работы, но перед этим уточняю последние критически важные детали.');

const answer1 = await message.ask(
  'Короткий вопрос 1. Название старой темы у вас было про «улучшение агентных способностей современных LLM». Вы хотите, чтобы я:\n' +
  'а) сохранил это название почти как есть;\n' +
  'б) сделал более точную научную формулировку, но близкую по смыслу;\n' +
  'в) сделал новое, более сильное название с акцентом на TELOS как авторскую систему.\n' +
  'Если можете — предложите 1–3 варианта, которые вам нравятся.'
);
console.log('title answer:', answer1);

const answer2 = await message.ask(
  'Короткий вопрос 2. Для практической/исследовательской части: хотите ли вы, чтобы я включил именно ФОРМАЛЬНОЕ сравнение нескольких архитектурных этапов TELOS (например: старый loop-подход → provider tools + code-as-action → heartbeat/proactivity), чтобы показать эволюцию как исследование? Или лучше сделать упор на описание итоговой архитектуры и кейсов без жёсткого сравнительного эксперимента?'
);
console.log('experiment answer:', answer2);

const answer3 = await message.ask(
  'Короткий вопрос 3. Есть ли личные примеры, которые лучше НЕ включать в текст, даже если они сильные? Например, 13_personal, жизненные решения, школьный мониторинг после школы и т.п. Я могу описать это аккуратно и обезличенно, но хочу понять границу допустимого.'
);
console.log('privacy answer:', answer3);

const answer4 = await message.ask(
  'Короткий вопрос 4. Нужен ли вам в итоге только новый текст работы в markdown/docx-формате, или мне уже на этом этапе сразу готовить полноценный финальный .docx с оформлением?'
);
console.log('format answer:', answer4);

fs.writeFileSync('./final_clarifications.json', JSON.stringify({answer1, answer2, answer3, answer4}, null, 2), 'utf8');
console.log('Saved final_clarifications.json');
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
