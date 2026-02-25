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


FINISH("Выполнил упражнение 156 по русскому языку как ученик в тетради. В файле exercise_156_raw.txt сохранён результат:\n\n1. Расставлены знаки препинания во всех предложениях.\n2. Придаточные обстоятельственные выделены скобками.\n3. Указаны союзы и союзные слова, присоединяющие придаточные к главным предложениям.\n4. Составлены схемы для предложений 2, 5, 6, 7 в текстовом формате: [ — = ].\n5. Устная часть (определение значений придаточных по таблице) пропущена, как и требовалось.\n\nРезультат оформлен в соответствии с инструкциями: подчёркивания обозначены скобками, схемы представлены текстовыми скобками, все пункты задания выполнены.");
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
