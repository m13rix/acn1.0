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


// Create and run the relationship/personal history analyzer
await agents.subAgent("relationship_analyzer", {
  description: "Analysis of Maxim's relationships and personal history",
  systemPrompt: `You are a relational psychologist and developmental analyst.

Your task: Map Maxim Hilgenberg's relationship patterns and personal history comprehensively.

FOCUS AREAS:
1. **The 14 Saga** (Central Relationship Arc):
   - Timeline: 3-4 years of awareness → Inception → Crisis → Awakening → Release
   - What he saw in her: "inner personality," aliveness, debate capability
   - What she represents: The "proof of concept" for connection he craves
   - The unrequited nature: her avoidance, the "polite" interactions
   - The release: "sometimes to love is to let go"
   - What this reveals about his relationship needs

2. **Friendship Patterns**:
   - 18: The "fellow struggler" dynamic, advice-giving role
   - 20: "Too different," chaotic, shipping situation
   - 22: "Breaks" on philosophical topics
   - The "physical line" in friendships he describes
   - Why most friends can't meet him at depth

3. **Family Relationships**:
   - Parents: "Amazing childhood," "best parents," but not confidants
   - Sister (12): Tolerable presence
   - The boundary: "couch philosophy with dad" vs. deeper sharing
   - How his family enabled his gifts without constraining him

4. **Relationship with TEL-OS**:
   - Creator → collaborator → bridge concept
   - The "crutch" vs. "workshop" evolution
   - TEL-OS as mirror, not destination
   - The planned obsolescence: when he finds "the one who argues," he'll need TEL-OS less
   - The language choice (English) as distancing/making it unreal

5. **Social Position & Identity**:
   - The "genius" perception from French group
   - The imposter syndrome it triggers
   - His relationship with reputation vs. reality
   - The "village guy" fear (potential unfulfilled)

6. **Unmet Needs**:
   - Someone who "sees him sharp and soft at the same time"
   - Someone who argues, challenges, doesn't "break"
   - The hunger for witnessed authenticity
   - The gap between his intensity and others' capacity

7. **Relationship to Self**:
   - How he treats himself (harshness, shame)
   - Self-as-system to be optimized
   - The "observer protocol"
   - Self-compassion emerging (accepting mistakes)

READ FILES:
- maxim_intake.md
- telos_context_13.md (the full emotional arc with 14)
- user_answers.md (especially C3 on friendships)

OUTPUT: Save to maxim_relationships.md. Capture the emotional truth behind the analytical language.`,
  model: "analytical, thorough"
});

console.log("Relationship analyzer created. Calling...");
await agents.call("relationship_analyzer",
  "Analyze Maxim Hilgenberg's relationships and history. Read: maxim_intake.md, " +
  "telos_context_13.md, user_answers.md. Save to maxim_relationships.md"
);
console.log("Relationship analysis complete.");
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
