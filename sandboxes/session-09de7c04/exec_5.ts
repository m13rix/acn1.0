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


const fs = require('fs');
const path = require('path');

// Проверяем через 15 секунд
setTimeout(async () => {
  console.log("Проверяю файл research.md...");
  if (fs.existsSync('./research.md')) {
    const stats = fs.statSync('./research.md');
    console.log(`Файл найден, размер: ${stats.size} байт`);
    const content = fs.readFileSync('./research.md', 'utf8');
    console.log("Первые 800 символов:");
    console.log(content.substring(0, 800));
    
    // Если файл есть, запускаем писателя
    await agents.call("writer", `Используя информацию из файла research.md, напиши школьный доклад по роману Михаила Лермонтова «Герой нашего времени» для 9 класса. Объём: 1-2 страницы.\n\nТребования:\n1. Соблюдай структуру: введение, основная часть, заключение.\n2. В основной части должны быть разделы:\n   - История создания романа\n   - Тема, идея, проблематика\n   - Сюжет и композиция (особое внимание!)\n   - Образ Печорина\n   - Значение романа в литературе\n3. Пиши понятным, доступным языком для школьников.\n4. Используй факты из исследования.\n5. В конце можешь добавить краткий список литературы.\n6. Сохрани результат в файл report.md в формате Markdown с YAML frontmatter (как в примере ниже).\n\nПример YAML frontmatter:\n---\ntitle: «Герой нашего времени» М.Ю. Лермонтова\nauthor: Telos (M13RIX)\ndate: 2024\n---\n\nПосле создания report.md выведи сообщение о завершении.`);
  } else {
    console.log("Файл research.md до сих пор не создан. Возможно, исследование требует больше времени или произошла ошибка.");
    console.log("Проверяю текущую директорию:");
    const files = fs.readdirSync('.');
    console.log("Файлы в директории:", files);
  }
}, 15000);
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
