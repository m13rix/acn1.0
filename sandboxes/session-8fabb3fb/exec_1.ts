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


// Let's extract key insights from each focus area
const fs = require('fs');

// Re-read files for analysis
const intake = fs.readFileSync('maxim_intake.md', 'utf-8');
const telos = fs.readFileSync('telos_context_13.md', 'utf-8');
const answers = fs.readFileSync('user_answers.md', 'utf-8');

console.log('Extracting patterns...');

// Parse the 14 Saga from telos_context_13.md
// The conversation with Telos reveals the emotional arc:
// - Inception: AI-manipulated attachment via TEL-OS feature
// - Crisis: Holidays breakdown, 2 weeks pre-suicidal ideation
// - Awakening: Watching Eternal Sunshine, "Okay" revelation
// - Release: "sometimes to love is to let go"
// - What he saw in her: "inner personality," aliveness, debate capability

// Extract key quotes about 14
const fourteenPatterns = [];
const lines = telos.split('\n');
let capture = false;
for (let line of lines) {
    if (line.includes('14')) {
        fourteenPatterns.push(line.trim());
    }
    if (line.includes('inner personality') || line.includes('proof of concept')) {
        fourteenPatterns.push(line.trim());
    }
}

console.log('14-related lines:', fourteenPatterns.slice(0, 20));

// Extract friendship patterns from user_answers.md C3
const friendshipSection = answers.match(/C3 - (.*?)(?=\nC4|\nD1|$)/s);
console.log('Friendship section:', friendshipSection ? friendshipSection[0] : 'Not found');

// Extract family from D3
const familySection = answers.match(/D3 - (.*?)(?=\nE1|\nE2|$)/s);
console.log('Family section:', familySection ? familySection[0] : 'Not found');

// Extract TEL-OS relationship from telos context and G2
const telosSection = telos + '\n' + answers.match(/G2 - (.*?)(?=\nG3|$)/s)[0];
console.log('TEL-OS relationship clues');

// Extract social position from telos conversation about French group
const frenchGroup = telos.match(/French group.*?(?=\n|\.)/g);
console.log('French group mention:', frenchGroup);

// Extract unmet needs: "someone who sees him sharp and soft at the same time" etc.
const unmetNeeds = telos.match(/sees you sharp and soft.*?|bridge.*?destination|someone who argues.*?challenges/s);
console.log('Unmet needs mentions:', unmetNeeds);

// Extract relationship to self: "observer protocol", self-compassion, shame
const selfRelation = telos.match(/observer protocol|self-compassion|ashamed|shame|treats himself/g);
console.log('Self-relation mentions:', selfRelation);

// Let's write a comprehensive analysis based on these patterns
console.log('\n--- Starting analysis ---');
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
