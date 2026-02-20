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


// Send the final report to the user
const fs = require('fs');

// Read the report to confirm
const report = fs.readFileSync('MAXIM_HILGENBERG_COMPREHENSIVE_REPORT.md', 'utf-8');

console.log("=== REPORT DELIVERY ===");
console.log(`File: MAXIM_HILGENBERG_COMPREHENSIVE_REPORT.md`);
console.log(`Size: ${report.length} characters`);
console.log(`Sections: ${(report.match(/^#{1,3}\s.+$/gm) || []).length}`);

// Send the file
await message.sendFiles(['MAXIM_HILGENBERG_COMPREHENSIVE_REPORT.md']);
console.log("\n✓ Report sent to user");

// Also save to memory for future reference
await memory.addDoc('MAXIM_HILGENBERG_COMPREHENSIVE_REPORT.md');
console.log("✓ Report added to memory system");

console.log("\n=== DELIVERY COMPLETE ===");
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
