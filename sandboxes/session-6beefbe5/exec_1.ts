import * as files from '../../tools/files/index.js';

// Agent code execution
(async () => {
// Dynamic imports for npm packages (CJS/ESM interop)


...
})().catch(console.error).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
});
