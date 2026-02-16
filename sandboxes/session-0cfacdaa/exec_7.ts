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


// Соберу все найденные изображения
const allImages = [];

if (results && results.length > 0) {
    console.log("Тематические изображения по эмансипации:");
    for (let i = 0; i < results.length; i++) {
        console.log(`${i+1}. ${results[i].title} - ${results[i].url}`);
        allImages.push(results[i]);
    }
}

if (results2 && results2.length > 0) {
    console.log("\nИзображения 'подросток предприниматель':");
    for (let i = 0; i < Math.min(results2.length, 2); i++) {
        console.log(`${allImages.length + i + 1}. ${results2[i].title} - ${results2[i].url}`);
        allImages.push(results2[i]);
    }
}

if (results3 && results3.length > 0) {
    console.log("\nЮридические изображения:");
    for (let i = 0; i < Math.min(results3.length, 2); i++) {
        console.log(`${allImages.length + i + 1}. ${results3[i].title} - ${results3[i].url}`);
        allImages.push(results3[i]);
    }
}

if (results4 && results4.length > 0) {
    console.log("\nИзображения органов опеки и суда:");
    for (let i = 0; i < Math.min(results4.length, 2); i++) {
        console.log(`${allImages.length + i + 1}. ${results4[i].title} - ${results4[i].url}`);
        allImages.push(results4[i]);
    }
}

if (results5 && results5.length > 0) {
    console.log("\nКонцептуальные изображения:");
    for (let i = 0; i < Math.min(results5.length, 2); i++) {
        console.log(`${allImages.length + i + 1}. ${results5[i].title} - ${results5[i].url}`);
        allImages.push(results5[i]);
    }
}

console.log(`\nВсего найдено уникальных изображений: ${allImages.length}`);

// Создам файл со списком картинок для презентации
const fs = require('fs');

let imageList = "# Картинки для презентации по эмансипации несовершеннолетних\n\n";
imageList += "## Рекомендуемые изображения для слайдов\n\n";

// Группирую по категориям
imageList += "### 1. Прямые иллюстрации к теме эмансипации\n";
if (results && results.length > 0) {
    for (let i = 0; i < Math.min(results.length, 3); i++) {
        imageList += `${i+1}. **${results[i].title}**\n`;
        imageList += `   URL: ${results[i].url}\n`;
        if (results[i].originalUrl && results[i].originalUrl !== results[i].url) {
            imageList += `   Оригинал: ${results[i].originalUrl}\n`;
        }
        imageList += "\n";
    }
}

imageList += "\n### 2. Подростки-предприниматели и работающая молодежь\n";
if (results2 && results2.length > 0) {
    for (let i = 0; i < Math.min(results2.length, 2); i++) {
        imageList += `${i+1}. **${results2[i].title}**\n`;
        imageList += `   URL: ${results2[i].url}\n`;
        if (results2[i].originalUrl && results2[i].originalUrl !== results2[i].url) {
            imageList += `   Оригинал: ${results2[i].originalUrl}\n`;
        }
        imageList += "\n";
    }
}

imageList += "\n### 3. Юридическая тематика (ГК РФ, законы, документы)\n";
if (results3 && results3.length > 0) {
    for (let i = 0; i < Math.min(results3.length, 2); i++) {
        imageList += `${i+1}. **${results3[i].title}**\n`;
        imageList += `   URL: ${results3[i].url}\n`;
        if (results3[i].originalUrl && results3[i].originalUrl !== results3[i].url) {
            imageList += `   Оригинал: ${results3[i].originalUrl}\n`;
        }
        imageList += "\n";
    }
}

imageList += "\n### 4. Органы опеки и судебная система\n";
if (results4 && results4.length > 0) {
    for (let i = 0; i < Math.min(results4.length, 2); i++) {
        imageList += `${i+1}. **${results4[i].title}**\n`;
        imageList += `   URL: ${results4[i].url}\n`;
        if (results4[i].originalUrl && results4[i].originalUrl !== results4[i].url) {
            imageList += `   Оригинал: ${results4[i].originalUrl}\n`;
        }
        imageList += "\n";
    }
}

imageList += "\n### 5. Концептуальные изображения (свобода, ответственность, выбор)\n";
if (results5 && results5.length > 0) {
    for (let i = 0; i < Math.min(results5.length, 2); i++) {
        imageList += `${i+1}. **${results5[i].title}**\n`;
        imageList += `   URL: ${results5[i].url}\n`;
        if (results5[i].originalUrl && results5[i].originalUrl !== results5[i].url) {
            imageList += `   Оригинал: ${results5[i].originalUrl}\n`;
        }
        imageList += "\n";
    }
}

imageList += "\n## Как использовать\n";
imageList += "1. Скопируйте URL понравившейся картинки\n";
imageList += "2. Вставьте в браузер и скачайте изображение\n";
imageList += "3. Добавьте в презентацию (PowerPoint, Google Slides и др.)\n";
imageList += "4. Рекомендуется проверить лицензию изображений при публичном использовании\n";

fs.writeFileSync('картинки_для_презентации.md', imageList, 'utf8');
console.log("\nФайл 'картинки_для_презентации.md' создан с описанием и ссылками");

// Создам также простой текстовый файл со ссылками
let simpleList = "Ссылки на картинки для презентации по эмансипации:\n\n";
allImages.slice(0, 10).forEach((img, index) => {
    simpleList += `${index+1}. ${img.url}\n`;
});

fs.writeFileSync('ссылки_на_картинки.txt', simpleList, 'utf8');
console.log("Файл 'ссылки_на_картинки.txt' создан с прямыми ссылками");

// Попробую скачать несколько изображений для быстрого доступа
console.log("\nПопытка скачать несколько изображений...");
const https = require('https');
const fsPromises = require('fs').promises;

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
                const buffer = Buffer.concat(chunks);
                fs.writeFileSync(filename, buffer);
                resolve(filename);
            });
        }).on('error', reject);
    });
}

// Скачаю 3-5 первых изображений
const imagesToDownload = allImages.slice(0, 5);
let downloadedCount = 0;

for (let i = 0; i < imagesToDownload.length; i++) {
    try {
        const img = imagesToDownload[i];
        const ext = img.url.split('.').pop().split('?')[0];
        const safeExt = ['jpg', 'jpeg', 'png', 'gif'].includes(ext.toLowerCase()) ? ext : 'jpg';
        const filename = `image_${i+1}.${safeExt}`;
        
        console.log(`Скачиваю: ${filename} из ${img.url}`);
        await downloadImage(img.url, filename);
        downloadedCount++;
        console.log(`✓ Успешно скачано: ${filename}`);
    } catch (error) {
        console.log(`✗ Ошибка при скачивании: ${error.message}`);
    }
}

console.log(`\nСкачано изображений: ${downloadedCount}/${imagesToDownload.length}`);
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
