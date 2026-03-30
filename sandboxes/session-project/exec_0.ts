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


const answer = await message.ask(
  "Предлагаю такой план: 1) прочитаю все перечисленные локальные файлы и отдельно отмечу, что подтверждено напрямую, что реконструируется, а что является перспективным направлением; 2) проведу небольшой внешний research только по четырём рамочным темам для аккуратной интерпретации архитектуры TELOS; 3) соберу итог в markdown-файл ./chapter2_research_notes.md строго по вашей структуре.\n\nУточнение перед началом: делать акцент прежде всего на архитектурном описании текущего TELOS, а ACN упоминать только как предшествующий этап эволюции — верно? Если дополнительных пожеланий нет, просто ответьте 'да'."
);
console.log(answer);
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
