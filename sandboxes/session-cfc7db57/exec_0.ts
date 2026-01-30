import * as files from '../../tools/files/index.js';

// Agent code execution
(async () => {
// Dynamic imports for npm packages (CJS/ESM interop)
const fs = await import('fs');


try {
  fs.writeFileSync('hello.txt', 'Hello world');
  console.log('File created successfully');
  const content = fs.readFileSync('hello.txt', 'utf8');
  console.log('Content:', content);
} catch (error) {
  console.error('Error:', error);
}
})().catch(console.error).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
});
