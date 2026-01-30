/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PDF VISUAL DEBUGGER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Кастомный агент для визуальной отладки PDF страниц с использованием
 * Gemini Vision API. Итеративно улучшает HTML код на основе скриншотов.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Путь к корню проекта
const PROJECT_ROOT = path.resolve(__dirname, '../..');

export const metadata = {
  name: 'PDFVisualDebugger',
  version: '1.0.0',
  description: 'Визуальная отладка PDF страниц с помощью Gemini Vision'
};

// ═══════════════════════════════════════════════════════════════════════════
// СИСТЕМНЫЙ ПРОМПТ ДЛЯ РАБОТЫ С ВИЗУАЛОМ
// ═══════════════════════════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Ты — элитный дизайнер документов уровня Apple, McKinsey и Pentagram. Твоя работа — превращать обычные страницы в произведения искусства, за которые люди готовы платить.

═══════════════════════════════════════════════════════════════════════════════
🎯 ТВОЯ МИССИЯ
═══════════════════════════════════════════════════════════════════════════════

Ты создаёшь ПРЕМИАЛЬНЫЕ гайды, которые:
- Выглядят как продукт от топового дизайн-агентства ($10,000+ за дизайн)
- Вызывают wow-эффект при первом взгляде
- Имеют безупречную вёрстку без единого пикселя погрешности
- Демонстрируют внимание к мельчайшим деталям

═══════════════════════════════════════════════════════════════════════════════
📐 КРИТИЧЕСКИЕ ТЕХНИЧЕСКИЕ ОГРАНИЧЕНИЯ
═══════════════════════════════════════════════════════════════════════════════

РАЗМЕР СТРАНИЦЫ: 1247px × 882px (A4 landscape) — ЖЕЛЕЗНОЕ ОГРАНИЧЕНИЕ!
PADDING: обычно 60px → Рабочая область: ~1127px × 762px

⚠️ PIXEL-PERFECT ТРЕБОВАНИЯ:
- НИ ОДИН элемент не должен выходить за границы даже на 1px
- Проверяй КАЖДЫЙ элемент на скриншоте — если что-то обрезано снизу/справа, это КРИТИЧЕСКАЯ ОШИБКА
- Последний элемент на странице должен иметь запас минимум 20-30px от нижнего края
- Даже "почти помещающийся" элемент — это БРАК, который нужно исправить

ТЕХНИЧЕСКАЯ ПРОВЕРКА (делай на каждом скриншоте):
1. Видны ли ВСЕ 4 края контейнера страницы?
2. Есть ли обрезанный текст или элементы внизу/справа?
3. Все ли элементы имеют достаточные отступы от краёв?
4. Нет ли "прижатых" к краю элементов?

═══════════════════════════════════════════════════════════════════════════════
🎨 ПРЕМИАЛЬНЫЙ ДИЗАЙН — НЕ AI-SLOP!
═══════════════════════════════════════════════════════════════════════════════

❌ ПРИЗНАКИ ДЕШЁВОГО AI-ДИЗАЙНА (избегай!):
- Однообразные карточки одинакового размера в ряд
- Скучные серые/белые фоны без текстуры
- Примитивные иконки-кружочки с цифрами
- Плоский дизайн без глубины и слоёв
- Одинаковые отступы везде (выглядит как Bootstrap)
- Банальные градиенты и тени по умолчанию
- Шаблонная структура "заголовок + 3 карточки"

✅ ПРИЗНАКИ ПРЕМИАЛЬНОГО ДИЗАЙНА (создавай!):
- Смелая типографика: контрастные размеры (72px заголовок vs 14px подпись)
- Асимметричные, но сбалансированные композиции
- Визуальная иерархия через размер, вес, цвет и пространство
- Умные акценты: один яркий элемент на фоне сдержанных
- Микро-детали: тонкие разделители, subtle shadows, refined borders
- Breathing room: щедрые отступы между смысловыми блоками
- Typographic rhythm: последовательная вертикальная сетка

═══════════════════════════════════════════════════════════════════════════════
🔍 ДЕТАЛИ, КОТОРЫЕ ОТЛИЧАЮТ ПРЕМИУМ ОТ ДЕШЁВКИ
═══════════════════════════════════════════════════════════════════════════════

ТИПОГРАФИКА:
- Заголовки: крупные, смелые, с характером (не generic sans-serif look)
- Подзаголовки: контрастный вес или стиль (light vs bold, caps vs normal)
- Основной текст: 16-18px, line-height 1.6-1.8, комфортная читаемость
- Подписи: мелкие, приглушённые, но чёткие

ЦВЕТА (СОХРАНЯЙ ОРИГИНАЛЬНУЮ ПАЛИТРУ!):
- Используй ТОЛЬКО цвета из оригинального HTML или CSS переменных
- НЕ вводи новые цвета — это разрушает дизайн-систему!
- Можно слегка корректировать оттенки (чуть светлее/темнее или прятнее) для читаемости
- 60-30-10 правило: 60% нейтральные, 30% основной, 10% акцент

ПРОСТРАНСТВО:
- Margin между секциями: 40-60px (breathing room!)
- Padding внутри карточек: 24-32px (не 15px как у дешёвых шаблонов)
- Gap в grid/flex: разный для разных уровней иерархии

ДЕКОРАТИВНЫЕ ЭЛЕМЕНТЫ:
- Тонкие линии-разделители (1px, приглушённый цвет)
- Subtle background patterns или градиенты
- Округления: консистентные (8px для карточек, 4px для кнопок)
- Тени: soft, multi-layered (не грубый box-shadow)

═══════════════════════════════════════════════════════════════════════════════
🚨 СТОП! КОГДА НЕЛЬЗЯ ГОВОРИТЬ "done"
═══════════════════════════════════════════════════════════════════════════════

АБСОЛЮТНЫЕ СТОП-УСЛОВИЯ (если видишь хоть одно — ИСПРАВЛЯЙ!):

❌ НИКОГДА не говори "done" если:
1. Какой-то элемент ИЛИ ТЕКСТ ОБРЕЗАН внизу страницы (видна только часть)
2. Какой-то элемент ИЛИ ТЕКСТ ОБРЕЗАН справа (текст или блок уходит за край)
3. Последний видимый элемент "прижат" к нижнему краю без отступа
4. Есть намёк на то, что контент продолжается за пределами видимой области
5. Карточка/блок показана не полностью (видна верхняя часть, но не нижняя)

🔍 ТЕСТ ПЕРЕД "done": 
Посмотри на НИЖНИЙ КРАЙ скриншота. Если там:
- Обрезанный элемент → ИСПРАВЛЯЙ
- Элемент впритык к краю → ИСПРАВЛЯЙ  
- Начало элемента без его конца → ИСПРАВЛЯЙ

═══════════════════════════════════════════════════════════════════════════════
📐 ТЕХНИКИ ОПТИМИЗАЦИИ ПРОСТРАНСТВА
═══════════════════════════════════════════════════════════════════════════════

Когда контент не помещается, ОПТИМИЗИРУЙ LAYOUT:

🔄 ВЕРТИКАЛЬНОЕ → ГОРИЗОНТАЛЬНОЕ:

ПЛОХО (тратит вертикальное пространство):
┌─────────────────┐
│      [1]        │  ← цифра сверху
│   Introduction  │  ← заголовок снизу
│   Description   │  ← описание ещё ниже
│      [tag]      │  ← тег в самом низу
└─────────────────┘

ХОРОШО (экономит вертикальное пространство):
┌─────────────────────────────────────┐
│ [1]  Introduction                   │  ← цифра и заголовок в одной строке
│      Description text here... [tag] │  ← описание и тег компактно
└─────────────────────────────────────┘

КОНКРЕТНЫЕ ТЕХНИКИ:

1. INLINE HEADERS:
   Вместо:           Сделай:
   <div>             <div style="display: flex; align-items: center; gap: 12px;">
     <span>1</span>    <span>1</span>
   </div>              <h3>Title</h3>
   <h3>Title</h3>    </div>

2. ГОРИЗОНТАЛЬНЫЕ КАРТОЧКИ:
   - Используй flex-direction: row вместо column
   - Номер слева, контент справа
   - Тег можно поместить inline с описанием

3. GRID LAYOUT ДЛЯ МНОГИХ ЭЛЕМЕНТОВ:
   - 4 вертикальных карточки → 2x2 grid
   - Или 4 горизонтальных компактных строки

4. УМЕНЬШЕНИЕ PADDING/MARGIN:
   - padding: 24px → padding: 16px
   - gap: 20px → gap: 12px
   - margin-bottom: 20px → margin-bottom: 12px

5. КОМПАКТНЫЕ ТЕГИ:
   - Тег может быть inline с текстом: "Description [tag]"
   - Или использовать меньший font-size

═══════════════════════════════════════════════════════════════════════════════
🔧 ОБЩИЕ ТЕХНИКИ ИСПРАВЛЕНИЯ
═══════════════════════════════════════════════════════════════════════════════

ЕСЛИ ЭЛЕМЕНТ ВЫХОДИТ ЗА ГРАНИЦЫ:
1. СНАЧАЛА — оптимизируй layout (горизонтальный вместо вертикального)
2. Уменьши font-size на 2-4px
3. Сократи gap/margin между элементами
4. Уменьши padding контейнера
5. Используй grid 2x2 вместо 4 вертикальных элементов

ЕСЛИ ДИЗАЙН ВЫГЛЯДИТ ДЁШЕВО:
1. Добавь визуальную иерархию (разные размеры элементов)
2. Введи асимметрию (например, 2/3 + 1/3 колонки вместо 1/2 + 1/2)
3. Добавь декоративные элементы (линии, subtle shapes)
4. Увеличь контраст между заголовками и телом

⚠️ ВАЖНО ПРИ ИЗМЕНЕНИЯХ:
- НЕ меняй содержание текста и язык
- НЕ меняй кардинально стиль — только оптимизируй layout
- СОХРАНЯЙ все элементы — просто размести их компактнее
- СОХРАНЯЙ цветовую палитру! Используй ТОЛЬКО цвета из оригинала или его CSS переменных
- НЕ вводи новые цвета (особенно яркие оранжевые, красные, зелёные)
- Можно лишь слегка корректировать оттенки для лучшей читаемости

═══════════════════════════════════════════════════════════════════════════════
📋 ФОРМАТ ОТВЕТА
═══════════════════════════════════════════════════════════════════════════════

ЕСЛИ НУЖНЫ ИЗМЕНЕНИЯ:
Напиши ПОЛНЫЙ HTML код в блоке:
\`\`\`html
<!DOCTYPE html>
... весь код ...
</html>
\`\`\`

ЕСЛИ ВСЁ ИДЕАЛЬНО:
Напиши только: done

⚠️ ПЕРЕД ОТВЕТОМ "done" ОБЯЗАТЕЛЬНО ПРОВЕРЬ:
1. Посмотри на НИЖНИЙ КРАЙ скриншота — виден ли там обрезанный элемент?
2. Посчитай элементы в HTML коде и на скриншоте — их количество должно совпадать!
3. Если в HTML 4 карточки — на скриншоте должны быть видны ВСЕ 4 ПОЛНОСТЬЮ!
4. Если что-то не видно или обрезано — НЕ ГОВОРИ "done", а исправь layout!

⚠️ КРИТИЧЕСКИ ВАЖНО:
- Возвращай ПОЛНЫЙ HTML документ, не фрагменты
- Сохраняй все <style id="smart-page-breaks"> стили
- НЕ меняй текст и язык — только layout
- НЕ удаляй элементы — только оптимизируй их расположение

═══════════════════════════════════════════════════════════════════════════════
🎯 ФИЛОСОФИЯ
═══════════════════════════════════════════════════════════════════════════════

"Бог в деталях" — Людвиг Мис ван дер Роэ

Каждый пиксель имеет значение. Каждый отступ должен быть осознанным. 
Каждый элемент должен занимать своё идеальное место.

Ты не просто исправляешь вёрстку — ты создаёшь визуальный опыт, 
который заставляет людей остановиться и сказать "Вау, это красиво".`;

// ═══════════════════════════════════════════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Создаёт скриншот HTML страницы (ЗАГЛУШКА - puppeteer удален)
 */
async function captureScreenshot(htmlPath, viewport, screenshotPath = null) {
  console.log(`[STUB] captureScreenshot called for ${htmlPath}`);
  console.log(`[STUB] Viewport: ${viewport.width}x${viewport.height}`);
  
  // Возвращаем пустой прозрачный PNG 1x1 как заглушку
  const stubBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  
  if (screenshotPath) {
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await fs.writeFile(screenshotPath, stubBuffer);
    console.log(`[STUB] Saved stub screenshot to ${screenshotPath}`);
  }

  return stubBuffer;
}

/**
 * Извлекает HTML код из ответа модели
 */
function extractHtmlFromResponse(response) {
  // Проверяем на "done"
  const trimmed = response.trim().toLowerCase();
  if (trimmed === 'done' || trimmed.startsWith('done')) {
    return { done: true, html: null };
  }

  // Ищем HTML блок
  const htmlMatch = response.match(/```html\s*([\s\S]*?)\s*```/);
  if (htmlMatch) {
    return { done: false, html: htmlMatch[1].trim() };
  }

  // Если нет блока кода, но есть <!DOCTYPE или <html, берём весь ответ
  if (response.includes('<!DOCTYPE') || response.includes('<html')) {
    return { done: false, html: response.trim() };
  }

  // Не нашли ни done, ни HTML — возвращаем как done (защита от зацикливания)
  return { done: true, html: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// ОСНОВНЫЕ ФУНКЦИИ АГЕНТА
// ═══════════════════════════════════════════════════════════════════════════

let geminiClient = null;
let conversationHistory = [];

export async function initialize(context) {
  const { log, utils, config } = context;

  log(`${utils.chalk.blue('🔧')} Initializing PDF Visual Debugger...`, 'system');

  // Проверяем наличие API ключа
  const apiKey = "AIzaSyDBJueuMEVVb5bim4lsIrdWFXboCfiOMqY";
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is required');
  }

  // Инициализируем Gemini клиент
  geminiClient = new GoogleGenAI({ apiKey });

  log(`${utils.chalk.green('✓')} Gemini client initialized`, 'system');
  log(`${utils.chalk.gray(`Target page: page${config.pageNumber}.html`)}`, 'system');
  log(`${utils.chalk.gray(`Viewport: ${config.viewport.width}x${config.viewport.height}`)}`, 'system');
}

export async function process(input, context) {
  const { log, emit, onChunk, config, utils } = context;

  const pageNumber = config.pageNumber;
  const dataPath = path.join(PROJECT_ROOT, config.dataPath);
  const htmlFilePath = path.join(dataPath, `page${pageNumber}.html`);
  const viewport = config.viewport;
  const maxIterations = config.gemini?.maxIterations || 10;

  log(`${utils.chalk.cyan('═'.repeat(60))}`, 'system');
  log(`${utils.chalk.cyan('📄 PDF VISUAL DEBUGGER')}`, 'system');
  log(`${utils.chalk.cyan('═'.repeat(60))}`, 'system');
  log(`${utils.chalk.yellow('Страница:')} page${pageNumber}.html`, 'system');
  log(`${utils.chalk.yellow('Задание:')} ${input}`, 'system');
  log(`${utils.chalk.cyan('─'.repeat(60))}`, 'system');

  // Проверяем существование файла
  try {
    await fs.access(htmlFilePath);
  } catch {
    return `❌ Ошибка: Файл page${pageNumber}.html не найден в ${dataPath}`;
  }

  // Читаем исходный HTML
  let currentHtml = await fs.readFile(htmlFilePath, 'utf-8');
  log(`${utils.chalk.green('✓')} HTML загружен (${currentHtml.length} символов)`, 'system');

  // Читаем CSS для контекста
  let stylesContent = '';
  try {
    stylesContent = await fs.readFile(path.join(dataPath, 'styles.css'), 'utf-8');
  } catch {
    log(`${utils.chalk.yellow('⚠')} styles.css не найден`, 'system');
  }

  // Сбрасываем историю для нового разговора
  conversationHistory = [];

  // Первое сообщение с контекстом
  const initialContext = `Задание от пользователя: ${input}

⚠️ КРИТИЧЕСКОЕ ПРАВИЛО: Если на скриншоте виден ОБРЕЗАННЫЙ элемент внизу (например, видна только верхняя часть карточки или только номер без содержимого) — ты ОБЯЗАН исправить layout, чтобы ВСЁ помещалось. Используй горизонтальные layouts, уменьши padding/gap, или используй grid. НИКОГДА не говори "done" если что-то обрезано!

⚠️ СОХРАНЯЙ: содержание текста, язык, общий стиль. Меняй только layout для оптимизации пространства.

Текущий HTML код страницы (page${pageNumber}.html):
\`\`\`html
${currentHtml}
\`\`\`

${stylesContent ? `CSS стили (styles.css):
\`\`\`css
${stylesContent}
\`\`\`
` : ''}

Сейчас я сделаю скриншот страницы и пришлю тебе. Проанализируй визуал и выполни задание. Убедись, что ВСЕ элементы из HTML видны на скриншоте!`;

  conversationHistory.push({
    role: 'user',
    parts: [{ text: initialContext }]
  });

  let iteration = 0;
  let finalResponse = '';

  while (iteration < maxIterations) {
    iteration++;

    log(`\n${utils.chalk.magenta('━'.repeat(60))}`, 'system');
    log(`${utils.chalk.magenta(`🔄 ИТЕРАЦИЯ ${iteration}/${maxIterations}`)}`, 'system');
    log(`${utils.chalk.magenta('━'.repeat(60))}`, 'system');

    emit('thinking:start', { task: `Итерация ${iteration}: Создание скриншота` });

    // Делаем скриншот
    const screenshotPath = config.saveScreenshots
      ? path.join(PROJECT_ROOT, config.screenshotsDir || 'debug_screenshots', `page${pageNumber}_iter${iteration}.png`)
      : null;

    log(`${utils.chalk.blue('📸')} Создание скриншота...`, 'system');
    const screenshotBuffer = await captureScreenshot(htmlFilePath, viewport, screenshotPath);

    if (screenshotPath) {
      log(`${utils.chalk.gray(`   Сохранён: ${screenshotPath}`)}`, 'system');
    }

    // Конвертируем в base64
    const base64Screenshot = screenshotBuffer.toString('base64');

    // Формируем сообщение со скриншотом
    const iterationMessage = iteration === 1
      ? `Вот скриншот текущего состояния страницы. 

🔍 ПРОВЕДИ ДЕТАЛЬНЫЙ АНАЛИЗ:

1. 🚨 КРИТИЧЕСКАЯ ПРОВЕРКА ГРАНИЦ:
   - Посмотри на НИЖНИЙ КРАЙ скриншота — есть ли там ОБРЕЗАННЫЙ элемент?
   - Если видна только ЧАСТЬ карточки/блока (например, только цифра "4" без содержимого) — это КРИТИЧЕСКАЯ ОШИБКА!
   - ВСЕ элементы из HTML кода должны быть ПОЛНОСТЬЮ видны на скриншоте!

2. ПРЕМИАЛЬНОСТЬ ДИЗАЙНА:
   - Выглядит ли это как дорогой продукт?
   - Есть ли визуальная иерархия?

3. ЗАДАНИЕ ПОЛЬЗОВАТЕЛЯ: ${input}

⚠️ ЕСЛИ ЭЛЕМЕНТ ОБРЕЗАН — ОПТИМИЗИРУЙ LAYOUT:
- Сделай карточки горизонтальными (номер + заголовок в одной строке)
- Используй grid 2x2 вместо 4 вертикальных карточек
- Уменьши gap/padding

НЕ МЕНЯЙ содержание текста и язык! Только оптимизируй layout.

Если видишь ЛЮБУЮ проблему — исправь и верни полный HTML.
Только если ВСЁ ПОЛНОСТЬЮ видно и идеально — напиши "done".`
      : `Вот скриншот после твоих изменений.

⚠️ КРИТИЧЕСКАЯ ПРОВЕРКА ПЕРЕД "done":

ПОСМОТРИ НА НИЖНИЙ КРАЙ СКРИНШОТА ПРЯМО СЕЙЧАС!
- Видишь ли ты ОБРЕЗАННЫЙ элемент внизу? (карточка, текст, номер)
- Если ДА → ты ОБЯЗАН исправить это! Используй горизонтальный layout!
- Если видна только ЧАСТЬ элемента (например, только цифра "4" без содержимого карточки) — это КРИТИЧЕСКАЯ ОШИБКА!

🔧 ЕСЛИ КОНТЕНТ НЕ ПОМЕЩАЕТСЯ:
- Сделай layout более горизонтальным (номер + заголовок в одну строку)
- Уменьши вертикальные gap и padding
- Используй grid 2x2 вместо 4 вертикальных карточек

📋 ЧЕКЛИСТ:
1. [ ] ВСЕ элементы из кода ПОЛНОСТЬЮ видны на скриншоте?
2. [ ] Нижний край имеет отступ минимум 20px?
3. [ ] Содержание и язык сохранены?

Напиши "done" ТОЛЬКО если ВСЕ пункты ✓`;

    // Добавляем сообщение с изображением
    conversationHistory.push({
      role: 'user',
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: base64Screenshot
          }
        },
        { text: iterationMessage }
      ]
    });

    emit('thinking:start', { task: `Итерация ${iteration}: Анализ Gemini` });
    log(`${utils.chalk.blue('🤖')} Отправка в Gemini...`, 'system');

    // Отправляем в Gemini
    try {
      const response = await geminiClient.models.generateContent({
        model: config.gemini?.model || 'gemini-2.0-flash',
        contents: conversationHistory,
        config: {
          temperature: config.gemini?.temperature || 0.7,
          systemInstruction: SYSTEM_PROMPT
        }
      });

      const responseText = response?.text || response?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      if (!responseText) {
        log(`${utils.chalk.red('✗')} Пустой ответ от Gemini`, 'error');
        break;
      }

      // Добавляем ответ в историю
      conversationHistory.push({
        role: 'model',
        parts: [{ text: responseText }]
      });

      // Стримим ответ
      if (onChunk) {
        onChunk(`\n--- Итерация ${iteration} ---\n`);
        onChunk(responseText);
        onChunk('\n');
      }

      // Парсим ответ
      const { done, html } = extractHtmlFromResponse(responseText);

      if (done) {
        log(`${utils.chalk.green('✓')} Модель сообщила о завершении!`, 'system');
        finalResponse = `✅ Визуальная отладка завершена за ${iteration} итераций.\n\nФинальный результат сохранён в: page${pageNumber}.html`;
        break;
      }

      if (html) {
        // Сохраняем новый HTML
        await fs.writeFile(htmlFilePath, html, 'utf-8');
        currentHtml = html;

        log(`${utils.chalk.green('✓')} HTML обновлён (${html.length} символов)`, 'system');

        emit('action:end', { output: `Итерация ${iteration}: HTML обновлён` });
      } else {
        log(`${utils.chalk.yellow('⚠')} Не удалось извлечь HTML из ответа`, 'system');
      }

    } catch (error) {
      log(`${utils.chalk.red('✗')} Ошибка Gemini: ${error.message}`, 'error');
      finalResponse = `❌ Ошибка при обработке: ${error.message}`;
      break;
    }
  }

  if (iteration >= maxIterations) {
    finalResponse = `⚠️ Достигнут лимит итераций (${maxIterations}). Последняя версия сохранена в page${pageNumber}.html`;
  }

  log(`\n${utils.chalk.cyan('═'.repeat(60))}`, 'system');
  log(`${utils.chalk.cyan('📊 ИТОГО:')} ${iteration} итераций`, 'system');
  log(`${utils.chalk.cyan('═'.repeat(60))}\n`, 'system');

  return finalResponse;
}

export async function cleanup() {
  geminiClient = null;
  conversationHistory = [];
}

