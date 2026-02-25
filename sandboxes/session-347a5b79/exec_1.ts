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


// Переделываем вывод в формате "тетрадь ученика"
const fs = require('fs');

let output = "Упражнение 156\n\n";

// Списываем текст с расставленными знаками препинания
output += "Спишу текст с расставленными знаками препинания:\n\n";

const correctedSentences = [
    "1) Там, где ранее было устье реки, тропа взбирается на гору.",
    "2) Куда ни взгляднешь, всюду холмы.",
    "3) Когда мы достигли вершины горы, солнце уже успело подняться.",
    "4) Утром, как только мы отошли от бивака, тотчас же натолкнулись на тропу.",
    "5) Читатель ошибается, если представляет себе тайгу в виде рощи.",
    "6) Должно быть, солнце скрылось за горизонтом, потому что вдруг стало темно.",
    "7) Я решил подняться на гору, чтобы оттуда осмотреть окрестности.",
    "8) За время путешествия я так сжился с казаками, что мне не хотелось от них отделяться.",
    "9) Ночь была такая тихая, что даже осины замерли и не дрожали листьями."
];

correctedSentences.forEach(sent => {
    output += sent + "\n";
});

output += "\n\nВыделяю придаточные обстоятельственные, указываю союзы и союзные слова:\n\n";

const analysis = [
    {
        num: "1)",
        main: "Там тропа взбирается на гору",
        subordinate: "где ранее было устье реки",
        conjunction: "где — союзное слово",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "2)",
        main: "всюду холмы",
        subordinate: "Куда ни взгляднешь",
        conjunction: "куда — союзное слово",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "3)",
        main: "солнце уже успело подняться",
        subordinate: "Когда мы достигли вершины горы",
        conjunction: "когда — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "4)",
        main: "Утром тотчас же натолкнулись на тропу",
        subordinate: "как только мы отошли от бивака",
        conjunction: "как только — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "5)",
        main: "Читатель ошибается",
        subordinate: "если представляет себе тайгу в виде рощи",
        conjunction: "если — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "6)",
        main: "Должно быть, солнце скрылось за горизонтом",
        subordinate: "потому что вдруг стало темно",
        conjunction: "потому что — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "7)",
        main: "Я решил подняться на гору",
        subordinate: "чтобы оттуда осмотреть окрестности",
        conjunction: "чтобы — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "8)",
        main: "За время путешествия я так сжился с казаками",
        subordinate: "что мне не хотелось от них отделяться",
        conjunction: "что — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    },
    {
        num: "9)",
        main: "Ночь была такая тихая",
        subordinate: "что даже осины замерли и не дрожали листьями",
        conjunction: "что — союз",
        underline: "[подчёркиваем придаточное волнистой линией]"
    }
];

analysis.forEach(item => {
    output += `${item.num} Придаточное предложение: [${item.subordinate}]\n`;
    output += `   Присоединяется к главному с помощью: ${item.conjunction}\n`;
    output += `   ${item.underline}\n\n`;
});

output += "Составляю схемы предложений 2, 5, 6, 7:\n\n";
output += "2) [всюду холмы] — (куда ни взгляднешь), где «куда» — союзное слово\n";
output += "5) [Читатель ошибается] — (если представляет себе тайгу в виде рощи), где «если» — союз\n";
output += "6) [Должно быть, солнце скрылось за горизонтом] — (потому что вдруг стало темно), где «потому что» — союз\n";
output += "7) [Я решил подняться на гору] — (чтобы оттуда осмотреть окрестности), где «чтобы» — союз\n";

fs.writeFileSync('exercise_156_raw.txt', output, 'utf8');
console.log('Файл перезаписан в формате тетради.');
console.log(output);
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
