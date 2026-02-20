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


// Read the attached files directly to ensure accuracy
const fs = require('fs');

try {
  const interviewQs = fs.readFileSync('interview_questions.md', 'utf-8');
  const userAnswers = fs.readFileSync('user_answers.md', 'utf-8');
  const telosContext = fs.readFileSync('telos_context_13.md', 'utf-8');
  
  console.log("=== FILE VERIFICATION ===");
  console.log(`interview_questions.md: ${interviewQs.length} chars`);
  console.log(`user_answers.md: ${userAnswers.length} chars`);
  console.log(`telos_context_13.md: ${telosContext.length} chars`);
  
  // Save to ensure we have clean copies
  fs.writeFileSync('maxim_interview_questions.md', interviewQs);
  console.log("\nFiles verified and backed up.");
  
} catch (e) {
  console.error("Error:", e.message);
}
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
