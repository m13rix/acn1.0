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


console.log('Создаю подагента-писателя для поэтапной сборки новой исследовательской работы.');
await agents.subAgent('research_writer', {
  description: 'Пишет большие научно-исследовательские тексты на русском языке по готовой концепции и материалам анализа.',
  systemPrompt: 'Ты сильный научный автор на русском языке. Пишешь цельные, логичные, убедительные тексты для исследовательских работ высокого уровня. Нельзя фантазировать сверх данных. Нужно сочетать научность, правдоподобие для 9 класса и высокое качество. Работай последовательно, сохраняй результаты в markdown-файлы. Не делай параллельно несколько задач.',
  model: 'good at long-form academic writing in Russian'
});
console.log('Sub-agent research_writer created');
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
