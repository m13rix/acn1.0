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


// Теперь отформатируем решение через homework.formatHomework
const fs = require('fs');
const solutionContent = fs.readFileSync('./solution_262.txt', 'utf8');

console.log('Начинаю форматирование решения для печати...');
const formattedResult = await homework.formatHomework(solutionContent, 'homework_262.txt');
console.log('Результат форматирования:', formattedResult);

// Проверим, создался ли файл
if (fs.existsSync('./homework_262.txt')) {
  console.log('Файл homework_262.txt успешно создан!');
  
  // Отправим файл пользователю
  await message.sendFiles(['./homework_262.txt']);
  
  // Сообщим пользователю о завершении
  await message.sendText('✅ Задание выполнено и отформатировано для печати! Файл отправлен.');
  
  FINISH('Домашнее задание по русскому языку (упражнение 262) выполнено и отправлено!');
} else {
  console.log('Файл не создан, возможно ошибка форматирования');
  await message.sendText('Ошибка при форматировании файла. Попробую создать файл вручную...');
  
  // Создадим простой отформатированный файл вручную
  const manualFormatted = `Домашнее задание по русскому языку
Упражнение 262

${solutionContent}

Дата выполнения: ${new Date().toLocaleDateString('ru-RU')}`;
  
  fs.writeFileSync('./homework_manual_262.txt', manualFormatted);
  await message.sendFiles(['./homework_manual_262.txt']);
  await message.sendText('✅ Задание выполнено! Файл создан вручную и отправлен.');
  
  FINISH('Домашнее задание по русскому языку (упражнение 262) выполнено и отправлено (ручное форматирование)!');
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
