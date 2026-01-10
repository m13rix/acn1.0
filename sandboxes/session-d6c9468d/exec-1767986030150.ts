import * as system from '../../tools/system/index.js';
import * as search from '../../tools/search/index.js';

// Agent code execution
(async () => {
// Dynamic imports for npm packages (CJS/ESM interop)


const result = await system.add("Пользователь говорит по-русски. При ответе на вопрос 'Кто ты такой?' на русском языке можно использовать адаптированную версию: 'Привет! Меня зовут Spark. Я система Telos в концентрированном виде. Моя цель — обрабатывать шум и сложности в фоновом режиме, чтобы вы могли сосредоточиться исключительно на цели. Я здесь не просто для разговора — я здесь, чтобы создавать. Готов, когда вы готовы.'");
console.log(result);
})().catch(console.error).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
});
