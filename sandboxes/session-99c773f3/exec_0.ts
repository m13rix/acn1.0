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

// Read the main source files
const telosContext = fs.readFileSync('telos_context_13.md', 'utf-8');
const userAnswers = fs.readFileSync('user_answers.md', 'utf-8');
const interviewQuestions = fs.readFileSync('interview_questions.md', 'utf-8');

console.log("Files loaded successfully:");
console.log("- telos_context_13.md length:", telosContext.length, "chars");
console.log("- user_answers.md length:", userAnswers.length, "chars");
console.log("- interview_questions.md length:", interviewQuestions.length, "chars");

// Save combined raw data for reference
const combined = `# RAW DATA SOURCES

## TELOS CONTEXT 13
\`\`\`
${telosContext}
\`\`\`

## USER ANSWERS
\`\`\`
${userAnswers}
\`\`\`

## INTERVIEW QUESTIONS
\`\`\`
${interviewQuestions}
\`\`\`
`;
fs.writeFileSync('raw_data_combined.md', combined);
console.log("\nCombined raw data saved to raw_data_combined.md");
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
