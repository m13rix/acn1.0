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


// Создаем подагента-специалиста по русскому языку
console.log("Создаю подагента-специалиста по русскому языку...");
await agents.subAgent("russian_expert", {
  description: "Специалист по русскому языку, грамматике, синтаксису и пунктуации",
  systemPrompt: "Ты эксперт по русскому языку с глубокими знаниями в области синтаксиса, пунктуации и грамматики. Ты умеешь анализировать сложные предложения, выделять придаточные части, определять их типы и значения, расставлять знаки препинания, составлять схемы предложений. Ты внимателен к деталям и следуешь правилам русского языка. Все решения объясняй четко и аргументированно.",
  model: "good at russian"
});

console.log("Подагент создан. Передаю ему задание...");

// Передаем задание подагенту для выполнения
await agents.call("russian_expert", `Ты получил задание по русскому языку (упражнение 156). Тебе нужно выполнить ВСЕ подзадачи этого упражнения одним решением. Вот полный текст задания:

${taskText}

Твоя задача:
1. Проанализировать все 9 предложений из текста В. Арсеньева.
2. Выделить придаточные обстоятельственные в каждом предложении.
3. Указать, чем они присоединены к главному предложению (союз или союзное слово).
4. По таблице на с. 84-85 определить значение придаточных (вид обстоятельственных придаточных).
5. Списывать предложения, расставляя знаки препинания.
6. Обозначить придаточные предложения, а также союзные слова и союзы, присоединяющие придаточные к главному.
7. Составить схемы 2, 5, 6, 7-го предложений (как указано: "схемы 2, 5-7-го предложений" - значит схемы предложений 2, 5, 6, 7).

ВАЖНО: Ты должен предоставить ПОЛНОЕ решение всех подзадач упражнения. Результат должен быть готов для передачи функции форматирования homework.formatHomework.

Начни выполнение. После завершения сохрани результат в файл "exercise_156_solution.txt".`);
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
