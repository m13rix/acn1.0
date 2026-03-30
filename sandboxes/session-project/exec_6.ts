require('./globals.js');
const files = require('../../tools/files/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const notepad = require('../../tools/notepad/index.ts');
const realtime = require('../../tools/realtime/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const strategy = require('../../tools/strategy/index.ts');
const homework = require('../../tools/homework/index.ts');
const utils = require('../../tools/utils/index.ts');

// Agent code execution
(async () => {
// Package requires


const fs = require('fs');
const topics = [
  'OpenClaw agent framework architecture',
  'OpenCode AI agent architecture tools',
  'open-source agent framework code execution tool calling memory event driven'
];
const sections = [];
for (const topic of topics) {
  try {
    const ans = await search.answer(topic);
    sections.push(`## ${topic}\n\n${ans.answer || ''}\n\n### Citations\n${(ans.citations || []).map((c, i) => `${i+1}. ${c}`).join('\n')}`);
    console.log('DONE:', topic);
  } catch (e) {
    sections.push(`## ${topic}\n\nError: ${String(e)}`);
    console.log('ERROR:', topic, String(e));
  }
}
fs.writeFileSync('./external_frameworks_context.md', '# External comparative context\n\n' + sections.join('\n\n'), 'utf8');
console.log(fs.readFileSync('./external_frameworks_context.md', 'utf8'));
})().then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(async err => {
  console.error(err);
  process.exitCode = 1;
  await new Promise(resolve => setTimeout(resolve, 200));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exitCode = 1;
});
