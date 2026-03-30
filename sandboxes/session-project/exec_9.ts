require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
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
const path = './author_interview_round2.json';
let data = {};
if (fs.existsSync(path)) {
  try { data = JSON.parse(fs.readFileSync(path, 'utf8')); } catch {}
}

console.log('Начинаю последовательное интервью отдельными вопросами.');

async function askAndSave(key, question) {
  const answer = await message.ask(question);
  data[key] = answer;
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Saved ${key}`);
  console.log(answer);
}

await askAndSave('q1_scope', 'Вопрос 1. Я правильно понимаю, что новую работу лучше строить НЕ как абстрактное рассуждение про LLM-агентов, а как исследование эволюции вашей конкретной авторской системы ACN / Telos-подобного agentic harness? Или вы хотите сохранить более широкий тон?');

await askAndSave('q2_names', 'Вопрос 2. Насколько явно можно использовать в тексте названия ACN, Telos, OpenClaw, Cursor, OpenAI Codex, Gemini, Claude, NotebookLM и т.д.? Что из этого допустимо и желательно, а что лучше упоминать осторожно?');

await askAndSave('q3_old_topics', 'Вопрос 3. В старой работе был большой акцент на XML/JSON, ReAct, Accumulator Loop, Message Passthrough Loop, Planner/Executor, context pruning, memory и Code-as-Action. Какие из этих тем сейчас всё ещё центральные, а какие вы бы уже считали скорее историческим этапом, который надо сократить?');

await askAndSave('q4_main_thesis', 'Вопрос 4. Что вы считаете главным техническим тезисом новой работы? Можно выбрать один или несколько вариантов и переформулировать по-своему: а) агентам нужен более естественный интерфейс действия — код и provider tools вместо хрупких искусственных протоколов; б) ключ к качеству — не один механизм, а целая экосистема: sandbox + память + подагенты + события + инструменты; в) современные агентные системы становятся полезными только когда переходят от демонстраций к практическим сценариям; г) главное — проактивность и долговременная автономность; д) ваш вариант.');

await askAndSave('q5_heartbeat_role', 'Вопрос 5. Какую роль в новой работе должен играть heartbeat: как одна из функций системы, как один из важнейших прорывов, как мост от чат-бота к агенту, живущему во времени, или как-то иначе?');

await askAndSave('q6_memory_role', 'Вопрос 6. Про память: стоит ли делать на ней большой отдельный раздел, или лучше оставить её как важный, но не центральный компонент? Особенно интересует graph memory — включаем как серьёзную часть исследования или как перспективное направление / гипотезу?');

await askAndSave('q7_use_cases', 'Вопрос 7. Очень важно для практической части: кроме автоматизации домашней работы, какие реальные кейсы вы хотите видеть в новой работе как демонстрацию силы системы? Дайте, пожалуйста, ещё 5–10 примеров реального или очень показательного использования.');

await askAndSave('q8_proud_cases', 'Вопрос 8. Есть ли у вас какие-то особенно удачные истории или сценарии, которыми вы лично гордитесь? Например: система сама что-то исследовала, сама сгенерировала документ, помогла в реальной задаче, построила автоматизацию, создала агента, изменила собственный код и т.д.');

await askAndSave('q9_limitations', 'Вопрос 9. Какие у системы есть слабые места или честные ограничения, которые обязательно нужно указать, чтобы работа выглядела серьёзной и научной, а не рекламной?');

await askAndSave('q10_os_metaphor', 'Вопрос 10. Насколько смело можно писать про «операционную систему для ИИ»? Это красивая метафора, ваш рабочий инженерный термин, или лучше для школьной комиссии заменить на что-то вроде «агентная вычислительная среда», «агентный фреймворк» или «исполнительная среда для LLM-агентов»?');

await askAndSave('q11_metrics', 'Вопрос 11. Если бы нам нужно было сформулировать 3–5 критериев эффективности системы, какие бы вы выбрали? Например: устойчивость выполнения, практическая полезность, расширяемость, автономность, качество оркестрации, способность к самоизменению, удобство разработки и т.п.');

await askAndSave('q12_style', 'Вопрос 12. В новой работе вы хотите, чтобы я писал более смело — «я разработал», «мной была создана система», — или более нейтрально и академично — «в ходе проекта была разработана система»?');

await askAndSave('q13_prove', 'Вопрос 13. Есть ли вещи, которые вам принципиально хочется доказать этой работой? Не просто рассказать, а именно доказать перед комиссией.');

await askAndSave('q14_comparisons', 'Вопрос 14. Хотите ли вы, чтобы я потом отдельно подготовил блок сравнений с другими агентными системами — например, ReAct, AutoGen, CAMEL, ChatDev, OpenClaw и т.п. — как полноценный исследовательский раздел, или лучше не перегружать школьную работу?');

console.log('Интервью-раунд 2 завершён и сохранён в author_interview_round2.json');
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
