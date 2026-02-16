require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


// Поиск картинок для презентации по теме эмансипации несовершеннолетних
console.log("Начинаю поиск картинок для презентации...");

// Попробую найти различные тематические изображения
const results = await search.imageSearch("эмансипация несовершеннолетних право подростки", { limit: 5 });
console.log("Найдено результатов:", results.length);

if (results && results.length > 0) {
    console.log("Первые результаты:");
    for (let i = 0; i < Math.min(results.length, 3); i++) {
        console.log(`${i+1}. ${results[i].title} - ${results[i].url}`);
    }
} else {
    console.log("По первому запросу ничего не найдено");
}

// Поищу ещё по смежным темам
const results2 = await search.imageSearch("подросток предприниматель работа", { limit: 5 });
console.log("\nРезультаты по теме 'подросток предприниматель':", results2 ? results2.length : 0);

const results3 = await search.imageSearch("гражданский кодекс РФ юридические права", { limit: 5 });
console.log("Результаты по юридической теме:", results3 ? results3.length : 0);

const results4 = await search.imageSearch("органы опеки попечительства суд", { limit: 5 });
console.log("Результаты по теме 'органы опеки':", results4 ? results4.length : 0);

const results5 = await search.imageSearch("ответственность свобода право выбора", { limit: 5 });
console.log("Результаты по абстрактным концепциям:", results5 ? results5.length : 0);
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
