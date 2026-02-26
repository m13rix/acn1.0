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


// Самостоятельно решаю задачи
const task557 = "Смежные стороны параллелограмма равны 12 см и 14 см, а его острый угол равен 30°. Найдите площадь параллелограмма.";
const task559 = "Сторона параллелограмма равна 8,1 см, а диагональ, равная 14 см, образует с ней угол в 30°. Найдите площадь параллелограмма.";

// Решение задачи 557
// Площадь параллелограмма S = a * b * sin(α)
// a = 12 см, b = 14 см, α = 30°
// sin(30°) = 0.5
const S557 = 12 * 14 * 0.5; // 168 * 0.5 = 84

// Решение задачи 559
// Пусть сторона AB = 8.1 см, диагональ AC = 14 см, угол BAC = 30°
// Площадь треугольника ABC: S_ABC = 0.5 * AB * AC * sin(30°)
// S_ABC = 0.5 * 8.1 * 14 * 0.5 = 0.5 * 8.1 * 7 = 0.5 * 56.7 = 28.35
// Площадь параллелограмма = 2 * S_ABC = 56.7 см²
const S559 = 2 * 0.5 * 8.1 * 14 * 0.5; // 56.7

const solutionText = `Домашнее задание по геометрии (задачи 557 и 559)

Задача 557:
${task557}

Решение:
Дано: a = 12 см, b = 14 см, α = 30°
Формула площади параллелограмма: S = a * b * sin(α)
sin(30°) = 0.5
S = 12 * 14 * 0.5 = 168 * 0.5 = 84

Ответ: площадь параллелограмма равна 84 см².

---

Задача 559:
${task559}

Решение:
Дано: сторона a = 8,1 см, диагональ d = 14 см, угол между ними α = 30°
Рассмотрим треугольник, образованный стороной и диагональю.
Площадь этого треугольника: S_triangle = 0.5 * a * d * sin(α)
sin(30°) = 0.5
S_triangle = 0.5 * 8.1 * 14 * 0.5 = 0.5 * 8.1 * 7 = 0.5 * 56.7 = 28.35 см²
Площадь параллелограмма в два раза больше: S = 2 * S_triangle = 56.7 см²

Ответ: площадь параллелограмма равна 56,7 см².`;

console.log("Создаю итоговый файл с решениями...");
file("geometry_homework_solutions.txt", solutionText);
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
