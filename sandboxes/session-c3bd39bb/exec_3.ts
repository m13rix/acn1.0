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


// Проверим, создал ли подагент файл с решением
const fs = require('fs');
const path = require('path');

// Проверяем наличие файла
const solutionPath = './solution_262.txt';
if (fs.existsSync(solutionPath)) {
  console.log('Файл solution_262.txt найден!');
  const content = fs.readFileSync(solutionPath, 'utf8');
  console.log('Содержимое файла:');
  console.log(content);
  
  // Отправим сообщение пользователю, что задание выполнено
  await message.sendText('Задание выполнено! Файл с решением создан. Сейчас отформатирую его для печати.');
} else {
  console.log('Файл solution_262.txt еще не создан. Возможно, подагент все еще работает...');
  
  // Проверим другие возможные имена файлов
  const files = fs.readdirSync('.');
  console.log('Файлы в текущей директории:', files);
  
  // Если файл не найден, возможно подагент использовал другое имя
  const txtFiles = files.filter(f => f.endsWith('.txt'));
  console.log('Текстовые файлы:', txtFiles);
  
  if (txtFiles.length > 0) {
    for (const file of txtFiles) {
      console.log(`\n=== Содержимое ${file}: ===`);
      console.log(fs.readFileSync(file, 'utf8'));
    }
  } else {
    console.log('Ни одного текстового файла не найдено. Ждем завершения работы подагента...');
    await message.sendText('Подагент все еще выполняет задание. Подождите немного...');
  }
}
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
