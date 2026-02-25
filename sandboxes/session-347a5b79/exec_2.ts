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


// Финальная версия: делаем формат "как ученик в тетради"
const fs = require('fs');

let final = "Упражнение 156\n\n";

final += "1) Там, (где ранее было устье реки), тропа взбирается на гору. (где — союзное слово)\n";
final += "2) (Куда ни взглянешь), всюду холмы. (куда — союзное слово)\n";
final += "3) (Когда мы достигли вершины горы), солнце уже успело подняться. (когда — союз)\n";
final += "4) Утром, (как только мы отошли от бивака), тотчас же натолкнулись на тропу. (как только — союз)\n";
final += "5) Читатель ошибается, (если представляет себе тайгу в виде рощи). (если — союз)\n";
final += "6) Должно быть, солнце скрылось за горизонтом, (потому что вдруг стало темно). (потому что — союз)\n";
final += "7) Я решил подняться на гору, (чтобы оттуда осмотреть окрестности). (чтобы — союз)\n";
final += "8) За время путешествия я так сжился с казаками, (что мне не хотелось от них отделяться). (что — союз)\n";
final += "9) Ночь была такая тихая, (что даже осины замерли и не дрожали листьями). (что — союз)\n\n";

final += "Схемы предложений:\n";
final += "2) [всюду холмы] — (куда ни взглянешь)\n";
final += "5) [Читатель ошибается] — (если представляет себе тайгу в виде рощи)\n";
final += "6) [Должно быть, солнце скрылось за горизонтом] — (потому что вдруг стало темно)\n";
final += "7) [Я решил подняться на гору] — (чтобы оттуда осмотреть окрестности)\n";

fs.writeFileSync('exercise_156_raw.txt', final, 'utf8');
console.log('Финальная версия сохранена.');
console.log(final);
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
