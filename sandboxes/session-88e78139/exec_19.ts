require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const strategy = require('../../tools/strategy/index.ts');
const utils = require('../../tools/utils/index.ts');
const minecraft = require('../../tools/minecraft/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


const answer = await message.ask(`Спасибо, это очень полезные файлы — они подтверждают, что каркас выбран правильно:

1) Pre-verified Set Seed Execution
2) Practice-First Calibration
3) Seed-Map Scout-and-Set

Сейчас следующий слой — уже практический план:
- как именно выбрать/найти сид
- какие короткие skill-тесты провести перед стартом
- что брать в инвентарь на старте
- как строить opener, Nether-план и End-план
- какой именно dragon-finish оставить как основной для тебя

Хочешь, чтобы я углубился ещё на один уровень и собрал уже почти готовую пошаговую стратегию?

Ответь:
- да
- нет`);
console.log(String(answer));
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
