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


const svg557simple = await homework.generateSVG("Параллелограмм со сторонами 12 см и 14 см, острый угол 30 градусов");
const svg559simple = await homework.generateSVG("Параллелограмм со стороной 8.1 см и диагональю 14 см, угол между ними 30 градусов");
console.log("SVG сгенерированы");
file("task557_drawing.svg", svg557simple);
file("task559_drawing.svg", svg559simple);
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
