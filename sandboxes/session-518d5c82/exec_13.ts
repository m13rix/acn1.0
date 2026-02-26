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


const task557 = {};
const task559 = {};

const svg557 = await homework.generateSVG(task557);
const svg559 = await homework.generateSVG(task559);
console.log("SVG сгенерированы");
console.log("Длина SVG 557:", svg557.length);
console.log("Длина SVG 559:", svg559.length);
file("task557_drawing.svg", svg557);
file("task559_drawing.svg", svg559);
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
