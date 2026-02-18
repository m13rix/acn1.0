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


const fs = require('fs');

// Check if research is complete
let researchExists = fs.existsSync('research_domain_13.md');
let researchContent = '';
if (researchExists) {
  researchContent = fs.readFileSync('research_domain_13.md', 'utf-8');
  console.log(`Research file found: ${researchContent.length} characters`);
} else {
  console.log("Research still in progress (file not yet created)");
}

// Phase 3: Deploy Tree-of-Thought investigations
// Investigate each hypothesis in sequence

console.log("\n=== PHASE 3: TREE-OF-THOUGHT INVESTIGATIONS ===\n");

// H1: Systematizing-Avoidant Pattern (45% - highest priority)
await agents.subAgent("investigator_h1", {
  description: "Investigate H1: Systematizing-Avoidant Pattern",
  systemPrompt:
    "You are an analytical psychologist investigating the Systematizing-Avoidant Pattern hypothesis.\n\n" +
    "STEPS:\n\n" +
    "1. Read intake_updated.md, hypotheses_13.md, and research_domain_13.md (if exists)\n" +
    "2. Deeply examine: Is Maxim's pattern-systemization defensive or adaptive?\n\n" +
    "EVIDENCE TO EXAMINE:\n" +
    "- Sees number '14' everywhere (pattern recognition or obsession?)\n" +
    "- Frames relationships as optimization problems\n" +
    "- Cannot tolerate ambiguity - interprets everything as data\n" +
    "- 'Too loud' emotional presence\n" +
    "- Inability to form deep friendships except with 14\n" +
    "- Suicidal ideation triggered by rejection (attachment wound?)\n" +
    "- Intellectualization of emotions (emotions 'everywhere and nowhere')\n" +
    "\nARGUMENTS FOR (this being present):\n" +
    "- His descriptions fit avoidant intellectualization\n" +
    "- Achievement-based identity (genius potential vs insanity shame)\n" +
    "- Pattern recognition that excludes ambiguity\n\n" +
    "ARGUMENTS AGAINST:\n" +
    "- Excellent family background (secure attachment possible)\n" +
    "- Self-awareness suggests capacity for integration\n" +
    "- 'Okay' paradigm may indicate secure shift\n\n" +
    "CRITICAL:
" +
    "- Compare to Simon Baron-Cohen's 'extreme male brain' theory\n" +
    "- Look for evidence of alexithymia (difficulty identifying emotions)\n" +
    "- Test: does he process emotions through body (no) or only mind (yes)?\n" +
    "\nSUB-QUESTIONS:\n" +
    "SQ1: Is his emotional processing purely cognitive or embodied?\n" +
    "SQ2: Is 'cannot tolerate ambiguity' a permanent trait or situational?\n" +
    "SQ3: Does he have ANY non-achievement identity anchor?\n" +
    "SQ4: Is '14' pattern true pattern recognition or obsession confirmation bias?\n" +
    "SQ5: What is the attachment style: anxious (pursues), avoidant (flees), or fearful-avoidant?\n" +
    "\nCONFIDENCE ASSESSMENT:\n" +
    "- Rate H1 probability after investigation\n" +
    "- Identify key vulnerability (what would disprove this hypothesis?)\n\n" +
    "OUTPUT: Save detailed findings to h1_findings.md\n" +
    "Include: evidence for/against, sub-question answers, final probability estimate.",
  model: "analytical, thorough"
});

await agents.call("investigator_h1", 
  "Investigate H1: Systematizing-Avoidant Pattern (45% baseline). " +
  "Read intake_updated.md, hypotheses_13.md, and research_domain_13.md. " +
  "Deeply examine whether Maxim's cognition patterns represent defensive structure " +
  "or adaptive temperament. Save findings to h1_findings.md."
);

console.log("H1 investigation complete → h1_findings.md");

// H2: Engineering Temperament + Existential Crisis
await agents.subAgent("investigator_h2", {
  description: "Investigate H2: Healthy Existential Crisis",
  systemPrompt:
    "You are a developmental psychologist investigating: Is this normal adolescent development?\n\n" +
    "STEPS:\n" +
    "1. Read intake_updated.md and hypotheses_13.md\n" +
    "2. Evaluate: Is 15-year-old creating AI system normal intensity or pathological?\n\n" +
    "EVIDENCE FOR (this being healthy):\n" +
    "- Suicidal ideation recognized as 'never would have become actions'\n" +
    "- 'One of the best' parents, grateful for upbringing\n" +
    "- Self-corrects (released 14 without destruction)\n" +
    "- Metacognitively aware (recognizes patterns)\n" +
    "- Currently functioning well\n" +
    "- Sense of humor about intensity\n" +
    "\nEVIDENCE AGAINST:\n" +
    "- Build AI to manipulate his own behavior? Extreme\n" +
    "- Suicidal ideation at all concerning\n" +
    "- Pattern of obsession (14 → Singularity?)\n" +
    "- No peer relationships at depth\n" +
    "\nCOMPARE TO:\n" +
    "- Historical teenage prodigies (Psiaki, etc.)\n" +
    "- Normal adolescent identity intensity\n" +
    "- Existential crisis in gifted youth\n" +
    "\nSUB-QUESTIONS:\n" +
    "SQ1: Would high-systemization + capable introspection = normal for him?\n" +
    "SQ2: Is AI-mirror usage innovative or dissociative?\n" +
    "SQ3: Is 'Okay' shift genuine maturation or denial?\n" +
    "SQ4: What would 'normal' 15-year-old genius look like?\n" +
    "\nCONFIDENCE: Rate H2 probability.\n\n" +
    "Save to h2_findings.md",
  model: "analytical, thorough"
});

await agents.call("investigator_h2", 
  "Investigate H2: Engineering Temperament + Existential Crisis (30% baseline). " +
  "Determine if Maxim's presentation represents normal (albeit intense) adolescent development " +
    "versus pathology. Save to h2_findings.md."
);

console.log("H2 investigation complete → h2_findings.md");

console.log("\nH1 and H2 investigations deployed. Moving to H3-H6...\n");
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
