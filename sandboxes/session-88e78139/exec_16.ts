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


const answer = await message.ask(`Я уже вижу, что каркас стратегии сформировался:

- #1 Pre-verified Set Seed Execution
- #2 Practice-First Calibration
- #3 Seed-Map Scout-and-Set

Сейчас следующий полезный слой — это уже не семейства, а конкретика маршрута:
- какой именно стартовый opener
- какие тесты скилла провести и как их интерпретировать
- какой инвентарь / еду / инструменты брать
- как именно идти в Nether
- чем лучше убивать дракона именно тебе

Хочешь, чтобы я пошёл глубже ещё на один уровень и собрал уже почти готовый пошаговый маршрут?
Ответь:
- да — углубляйся
- нет — уже достаточно, собирай финальную стратегию`);
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
