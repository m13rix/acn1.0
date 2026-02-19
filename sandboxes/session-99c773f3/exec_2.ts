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


// PHASE 1: Domain Research - Before analyzing Maxim, I need to understand 
// the frameworks I'll use. Deploying researcher for adolescent psychology 
// and identity formation theory.

const researchPrompt = `
Research and compile a concise but comprehensive theoretical framework on:

1. ADOLESCENT IDENTITY FORMATION (Erikson, Marcia, contemporary views)
   - Key developmental tasks of age 15
   - Identity vs. role confusion stage
   - Crisis and commitment dynamics

2. META-COGNITIVE & SELF-REFLECTIVE DEVELOPMENT
   - Adolescent capacity for self-analysis
   - Impact of self-awareness on identity construction
   - The "observer self" phenomenon

3. CREATORS OF COMPLEX SYSTEMS
   - Psychological profiles of young system creators
   - The relationship between creator and creation
   - Identity implications of building analytical tools

4. TRANSFORMATION DURING THERAPEUTIC/REFLECTIVE CONVERSATION
   - Real-time identity change during dialogue
   - The "hot" vs. "cold" cognition distinction in self-discovery
   - Integration of insights into stable identity

Save to: research_identity_theory.md
Length: Comprehensive but focused (2000-3000 words)
Cite key theorists and concepts that will be relevant to analyzing a 15-year-old system creator undergoing transformation.
`;

console.log("Spawning domain researcher...");
console.log("Research focus: Identity formation, adolescent psychology, system creation psychology");
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
