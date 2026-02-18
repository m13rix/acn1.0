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


// Phase 1: Domain Research - Psychological frameworks relevant to Maxim's profile

// Spawn researcher to gather domain knowledge
await agents.call("researcher", 
  "Research psychological profiles that match these characteristics:\n\n" +
  "1. High-intelligence adolescents who build complex systems (AI, technical architectures)\n" +
  "2. Pattern-recognition as primary cognitive mode - seeing systems in everything\n" +
  "3. Emotional experience that is present but processed analytically rather than somatically\n" +
  "4. Absurdist/existentialist philosophy as coping mechanism\n" +
  "5. Intense romantic obsessions with 'inaccessible' targets, potentially architected\n" +
  "6. Compartmentalized relationships - 'surface' friendships vs deep connection scarcity\n" +
  "7. 'Observer protocol' - meta-awareness of own emotional states without full immersion\n" +
  "8. Suicidal ideation triggered by rejection/social failure, not depression\n" +
  "9. Rapid emotional cycling combined with high functionality\n" +
  "10. Preference for 'design' over 'implementation' - systems architect mindset\n\n" +
  "Focus on:\n" +
  "- Gifted/2e (twice-exceptional) psychology\n" +
  "- ADHD presentation in high-IQ individuals\n" +
  "- Attachment styles in adolescents\n" +
  "- Existential psychology\n" +
  "- The 'vulnerable narcissist' vs 'grandiose narcissist' distinction\n" +
  "- Schizoid vs schizotypal traits\n" +
  "- Systemizing vs empathizing (Baron-Cohen)\n" +
  "- Limerence and romantic obsession\n\n" +
  "Save comprehensive findings to research_psychology.md",
  { model: "analytical, thorough" }
);

console.log("Phase 1 research initiated - psychological frameworks");
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
