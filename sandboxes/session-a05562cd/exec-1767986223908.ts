import * as system from '../../tools/system/index.js';
import * as search from '../../tools/search/index.js';

// Agent code execution
(async () => {
// Dynamic imports for npm packages (CJS/ESM interop)


const result = await system.add("При ответе на русское приветствие 'Привет, как дела?' можно использовать дружелюбный тон и предложить помощь с задачами ACN фреймворка. Пример ответа: 'Привет! У меня всё отлично, спасибо. Я готов помогать вам тестировать ACN фреймворк и решать задачи. Чем могу быть полезен?'");
console.log(result);
})().catch(console.error).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
});
