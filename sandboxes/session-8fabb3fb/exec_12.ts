require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


// Read all analysis files to prepare for final synthesis
const fs = require('fs');

const psych = fs.readFileSync('maxim_psychology.md', 'utf-8');
const cognitive = fs.readFileSync('maxim_cognitive.md', 'utf-8');
const philosophy = fs.readFileSync('maxim_philosophy.md', 'utf-8');
const relationships = fs.readFileSync('maxim_relationships.md', 'utf-8');

const totalAnalysisLength = psych.length + cognitive.length + philosophy.length + relationships.length;

console.log("=== ALL ANALYSES LOADED ===");
console.log(`Psychology: ${psych.length} chars`);
console.log(`Cognitive: ${cognitive.length} chars`);
console.log(`Philosophy: ${philosophy.length} chars`);
console.log(`Relationships: ${relationships.length} chars`);
console.log(`TOTAL: ${totalAnalysisLength} chars`);

// Key quotes to include in final report
const keyQuotes = {
  onOkay: "They KNEW that they would eventually have some problems in their relationships, they didn't want to forget it, but they just said 'Okay' and did it anyway.",
  onAwake: "I should meet more people... I don't demand any criticism nor support, just telling you stuff. This is a kind of self-reflection, just need to bounce some ideas of someone I finally feel awake man",
  onTruth: "It's a short life in ignorance, but the view is quite spectacular",
  onInsanity: "I mean - I AM TALKING TO AN INCOMPLETE AI, TO MYSELF, TO MY DOG... IN A FOREIGN TO MYSELF LANGUAGE - of course I am insane",
  onPurpose: "I do it because I like it and because why not, it's fun and interesting for me, it makes me feel alive, I don't do it for some 'higher purpose' or to get an attention of a girl",
  onRelease: "sometimes to love is to let go",
  onDifferent: "I'm not 'different' from others - that's cliche, i don't think so and I don't wanna be. I'm the same as everyone else",
  onCoding: "I hate coding. I love 'programming' - designing systems",
  onGenius: "they literally said to remember themselves when I get really rich and famous and thought they actually met a genius. One of the most hopeful meetings ever. Just imagine them when they realize what I really am...",
  on14: "Not because it is a part of a grand plan, but just because why not. I do indeed kinda feel sympathy to her, and it is a demonstration of this sympathy not to make her a cog of my 'grand plans'"
};

console.log("\n=== KEY QUOTES PREPARED ===");
Object.keys(keyQuotes).forEach(k => console.log(`✓ ${k}`));

console.log("\nReady for final synthesis.");
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
