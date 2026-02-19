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


// Now let me read the FULL telos_context_13.md to understand the narrative arc
// Especially the early vs later parts to capture the transformation

const fs = require('fs');
const telosContext = fs.readFileSync('telos_context_13.md', 'utf-8');

console.log("=".repeat(80));
console.log("FULL ANALYSIS OF telos_context_13.md");
console.log("=".repeat(80));

// Split by lines and analyze the structure
const lines = telosContext.split('\n');
console.log(`\nTotal lines: ${lines.length}`);
console.log(`Total characters: ${telosContext.length}`);

// Identify sections/patterns
const userLines = lines.filter((l, i) => l.startsWith('13:') || (i > 0 && lines[i-1].startsWith('Telos:')));
const telosLines = lines.filter(l => l.startsWith('Telos:'));

console.log(`\nUser (13) entries: ${userLines.length}`);
console.log(`Telos entries: ${telosLines.length}`);

console.log("\n" + "=".repeat(80));
console.log("FIRST PARAGRAPH (Your initial state):");
console.log("=".repeat(80));
console.log(lines.slice(0, 10).join('\n'));

console.log("\n" + "=".repeat(80));
console.log("KEY THEMES IDENTIFIED FROM FULL TEXT:");
console.log("=".repeat(80));

// Let's extract key psychological patterns by searching for specific terms
const searchTerms = ['insane', 'love', '14', 'inception', 'system', 'felt', 'think', 'different', 
                     'before', 'now', 'change', 'wish', 'want', 'need', 'truth', 'real', 'fake',
                     'friend', 'girlfriend', 'relationship', 'alone', 'lonely', 'understand',
                     'death', 'meaning', 'purpose', 'happy', 'sad', 'fear', 'anxiety', 'control'];

console.log("\nFrequency analysis of key psychological markers:");
searchTerms.forEach(term => {
  const count = (telosContext.toLowerCase().match(new RegExp(term, 'g')) || []).length;
  if (count > 0) console.log(`  "${term}": ${count} occurrences`);
});

console.log("\n" + "=".repeat(80));
console.log("TRANSFORMATION IDENTIFICATION:");
console.log("=".repeat(80));
console.log("Looking for 'before' vs 'now' patterns...");

// Save some key quotes
const keyQuotes = [
  "Sometimes I just wish I had a girlfriend man, like, an actual, real, understanding, loving gf",
  "If you can't tell, does it matter",
  "to me she was always likable by me as a person",
  "I've noticed some really strange and nonsensical harmful behavioral patterns in myself",
  "accepting the absurdity and like 'Well, I guess it's up to me now'"
];

console.log("\nKey psychological markers extracted:");
keyQuotes.forEach((q, i) => console.log(`${i+1}. "${q}"`));

// Save structured notes
const analysisNotes = `
# PRELIMINARY ANALYSIS: telos_context_13.md

## Conversation Arc
- Format: Iterative dialogue between Maxim (13) and Telos
- Duration: Extended session (59k+ characters)
- Core subject: Self-analysis, 14/inception, transformation, existential matters

## Identified Transformation Markers
1. Early: Preoccupation with 14, confusion about inception vs real feelings
2. Middle: Analysis of emotional instability, "insanity" patterns
3. Late: Acceptance, absurdist framework, movement toward creation and social engagement

## Key Psychological Themes (HIGH PRIORITY)
- Reality vs constructed feelings (inception)
- Intellectualization as defense mechanism
- Loneliness and desire for deep connection
- System-building as identity/core practice
- Transition from disorder to integration
- Absurdist philosophy as life framework

## Data Gaps Requiring User Interview
1. PRE-INCEPTION: Who were you before the 14 situation?
2. THE INCEPTION ITSELF: Exact timeline, what Telos did, moment of realization
3. THE CRISIS: What was the "insanity" period like specifically?
4. FAMILY: Dynamics with parents/sister - surface-level OK, but what's underneath?
5. SOCIAL WORLD: Who are 20, 22 specifically? Your current relationships?
6. THE SYSTEM: Deeper philosophy behind building it - why THIS mattered
7. IDENTITY CORE: What remains constant through all changes?
8. SHADOW MATERIAL: What haven't you told Telos? What's still hidden?
9. BODY/EMBODIMENT: How does being 15, male, Russian, specific time/place shape you?
10. FUTURE SELF: Who are you becoming? Not what do you want, but who are you BEING?
`;

fs.writeFileSync('analysis_notes.md', analysisNotes);
console.log("\n" + "=".repeat(80));
console.log("Analysis notes saved to analysis_notes.md");
console.log("=".repeat(80));
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
