import * as system from '../../tools/system/index.js';
import * as search from '../../tools/search/index.js';

// Agent code execution
(async () => {
// Dynamic imports for npm packages (CJS/ESM interop)


const result = await system.search("google-img-scrap");
console.log(result);
})().catch(console.error).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
});
