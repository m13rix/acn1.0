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


// Actually calling the researcher agent
await agents.call("researcher",
  "Research and compile a concise but comprehensive theoretical framework on:\n\n" +
  "1. ADOLESCENT IDENTITY FORMATION (Erikson, Marcia, contemporary views)\n" +
  "   - Key developmental tasks of age 15\n" +
  "   - Identity vs. role confusion stage\n" +
  "   - Crisis and commitment dynamics\n\n" +
  "2. META-COGNITIVE & SELF-REFLECTIVE DEVELOPMENT\n" +
  "   - Adolescent capacity for self-analysis\n" +
  "   - Impact of self-awareness on identity construction\n" +
  "   - The 'observer self' phenomenon\n\n" +
  "3. CREATORS OF COMPLEX SYSTEMS\n" +
  "   - Psychological profiles of young system creators\n" +
  "   - The relationship between creator and creation\n" +
  "   - Identity implications of building analytical tools\n\n" +
  "4. TRANSFORMATION DURING THERAPEUTIC/REFLECTIVE CONVERSATION\n" +
  "   - Real-time identity change during dialogue\n" +
  "   - The 'hot' vs. 'cold' cognition distinction in self-discovery\n" +
  "   - Integration of insights into stable identity\n\n" +
  "Save to: research_identity_theory.md\n" +
  "Length: Comprehensive but focused (2000-3000 words)\n" +
  "Cite key theorists and concepts that will be relevant to analyzing a 15-year-old system creator undergoing transformation."
);

console.log("Researcher agent dispatched. Waiting for completion...");
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
