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


// Всё в одном action для сохранения контекста
console.log("Начинаю поиск и обработку картинок для презентации...");

// Поиск картинок по разным темам
console.log("1. Поиск тематических изображений по эмансипации...");
const results1 = await search.imageSearch("эмансипация несовершеннолетних право подростки", { limit: 5 });

console.log("2. Поиск изображений подростков-предпринимателей...");
const results2 = await search.imageSearch("подросток предприниматель работа", { limit: 5 });

console.log("3. Поиск юридических изображений...");
const results3 = await search.imageSearch("гражданский кодекс РФ юридические права", { limit: 5 });

console.log("4. Поиск изображений органов опеки и суда...");
const results4 = await search.imageSearch("органы опеки попечительства суд", { limit: 5 });

console.log("5. Поиск концептуальных изображений...");
const results5 = await search.imageSearch("ответственность свобода право выбора", { limit: 5 });

// Собираю все изображения
const allImages = [];
const categories = [
    { name: "Прямые иллюстрации к теме эмансипации", results: results1 },
    { name: "Подростки-предприниматели и работающая молодежь", results: results2 },
    { name: "Юридическая тематика (ГК РФ, законы, документы)", results: results3 },
    { name: "Органы опеки и судебная система", results: results4 },
    { name: "Концептуальные изображения (свобода, ответственность, выбор)", results: results5 }
];

// Создаю файл с описанием
const fs = require('fs');
let markdownContent = "# Картинки для презентации по эмансипации несовершеннолетних\n\n";
markdownContent += "## Рекомендуемые изображения для слайдов\n\n";

for (const category of categories) {
    if (category.results && category.results.length > 0) {
        markdownContent += `### ${category.name}\n`;
        
        for (let i = 0; i < Math.min(category.results.length, 3); i++) {
            const img = category.results[i];
            markdownContent += `${i+1}. **${img.title || 'Без названия'}**\n`;
            markdownContent += `   URL: ${img.url}\n`;
            if (img.originalUrl && img.originalUrl !== img.url) {
                markdownContent += `   Оригинал: ${img.originalUrl}\n`;
            }
            if (img.width && img.height) {
                markdownContent += `   Размер: ${img.width}x${img.height}\n`;
            }
            markdownContent += "\n";
            
            // Сохраняю в общий список
            allImages.push(img);
        }
        markdownContent += "\n";
    }
}

markdownContent += "## Как использовать\n";
markdownContent += "1. Скопируйте URL понравившейся картинки\n";
markdownContent += "2. Вставьте в браузер и скачайте изображение\n";
markdownContent += "3. Добавьте в презентацию (PowerPoint, Google Slides и др.)\n";
markdownContent += "4. Рекомендуется проверить лицензию изображений при публичном использовании\n\n";
markdownContent += `Всего найдено уникальных изображений: ${allImages.length}\n`;

// Сохраняю markdown файл
fs.writeFileSync('картинки_для_презентации.md', markdownContent, 'utf8');
console.log(`✓ Создан файл 'картинки_для_презентации.md' с ${allImages.length} изображениями`);

// Создаю простой файл со ссылками
let linksContent = "Ссылки на картинки для презентации по эмансипации несовершеннолетних:\n\n";
allImages.slice(0, 15).forEach((img, index) => {
    linksContent += `${index+1}. ${img.url}\n`;
});

fs.writeFileSync('ссылки_на_картинки.txt', linksContent, 'utf8');
console.log("✓ Создан файл 'ссылки_на_картинки.txt' с прямыми ссылками");

// Пытаюсь скачать несколько изображений
console.log("\nПопытка скачать несколько изображений для быстрого доступа...");
const https = require('https');

async function downloadImage(url, filename) {
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Ошибка ${response.statusCode}`));
                return;
            }
            
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                try {
                    const buffer = Buffer.concat(chunks);
                    fs.writeFileSync(filename, buffer);
                    resolve(filename);
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

// Скачиваю первые 5 изображений
const imagesToDownload = allImages.slice(0, 5);
let downloaded = 0;

for (let i = 0; i < imagesToDownload.length; i++) {
    try {
        const img = imagesToDownload[i];
        // Получаем расширение из URL
        const urlParts = img.url.split('.');
        let ext = 'jpg'; // по умолчанию
        if (urlParts.length > 1) {
            ext = urlParts[urlParts.length - 1].toLowerCase();
            // Очищаем от параметров
            ext = ext.split('?')[0].split('#')[0];
            if (!['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext)) {
                ext = 'jpg';
            }
        }
        
        const filename = `presentation_image_${i+1}.${ext}`;
        console.log(`Скачиваю ${i+1}/${imagesToDownload.length}: ${filename}`);
        
        await downloadImage(img.url, filename);
        downloaded++;
        console.log(`  ✓ Успешно: ${filename}`);
    } catch (error) {
        console.log(`  ✗ Ошибка: ${error.message}`);
    }
}

console.log(`\nСкачано изображений: ${downloaded}/${imagesToDownload.length}`);

// Показываю итог
console.log("\n=== ИТОГ ===");
console.log(`Найдено изображений по категориям:`);
categories.forEach(cat => {
    console.log(`  • ${cat.name}: ${cat.results?.length || 0} шт.`);
});

console.log(`\nСозданы файлы:`);
console.log(`  1. картинки_для_презентации.md - структурированный список с описанием`);
console.log(`  2. ссылки_на_картинки.txt - простой список ссылок`);
console.log(`  3. presentation_image_*.{jpg/png} - ${downloaded} скачанных изображений`);
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
