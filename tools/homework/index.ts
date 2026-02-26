/**
 * Инструмент для работы с домашними заданиями.
 * Позволяет получать информацию из школьных учебников, тексты заданий и параграфов,
 * а также генерировать SVG рисунки и форматировать готовые задания.
 */

import { GoogleGenAI } from '@google/genai';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getApiKey(): string {
    const GEMINI_API_KEY = process.env.GEMINI_KEY || process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        throw new Error(
            "GEMINI_KEY не настроен. Добавьте переменную в .env файл."
        );
    }
    return GEMINI_API_KEY;
}

/**
 * Получает текст задания, параграфа или любую другую информацию из указанного учебника с использованием NotebookLM.
 *
 * @param bookId - ID учебника. Допустимые значения: 'algebra', 'geometry', 'social_studies', 'history', 'russian'.
 * @param question - Вопрос (например, "Выведи ПОЛНОЦЕННЫЙ ТЕКСТ ЗАДАНИЯ номер 156 в этом учебнике...").
 * @returns Ответ модели на основе содержания учебника.
 * @example
 * const result = await ask("algebra", "Выведи полный текст задания номер 156");
 */
export async function ask(bookId: string, question: string): Promise<string> {
    const validBooks = ['algebra', 'geometry', 'social_studies', 'history', 'russian'];
    if (!validBooks.includes(bookId)) {
        throw new Error(`Недопустимый ID учебника: ${bookId}. Допустимые значения: ${validBooks.join(', ')}`);
    }

    const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
    const PROFILE_DIR = path.resolve(PROJECT_ROOT, 'browser-profile');

    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: PROFILE_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--start-maximized'
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: null
    });

    try {
        const pages = await browser.pages();
        const page = pages.length > 0 ? pages[0] : await browser.newPage();

        // Разрешаем работу с буфером обмена
        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://notebooklm.google.com', ['clipboard-read', 'clipboard-write']);

        await page.goto('https://notebooklm.google.com/notebook/b14102a9-29f2-4cf9-ad2a-10238008c138?authuser=1', { waitUntil: 'domcontentloaded', timeout: 60000 });

        const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
        await delay(5000); // Ждем основательной загрузки интерфейса

        // 1. Открываем настройки чата и удаляем историю
        try {
            const chatSettingsSelector = 'button[aria-label="Настройки чата"]';
            await page.waitForSelector(chatSettingsSelector, { timeout: 10000 });
            await page.click(chatSettingsSelector);
            await delay(2000);

            // 2. Нажимаем "Удалить историю чата"
            await page.evaluate(() => {
                const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
                const deleteItem = items.find(el => el.textContent?.includes('Удалить историю'));
                if (deleteItem) (deleteItem as HTMLElement).click();
            });
            await delay(2000);

            // 3. Подтверждаем удаление
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const yesBtn = btns.find(b => b.textContent?.includes('Удалить') || b.classList.contains('yes-button'));
                if (yesBtn) yesBtn.click();
            });
            await delay(3000); // Ждем очистки
        } catch (e) {
            console.warn("[homework.ask] Не удалось очистить историю чата, возможно она уже пуста или интерфейс не загрузился.");
        }

        // Запоминаем текущее количество сообщений, чтобы не считать старые
        const messageContentSelector = '.message-text-content';
        const initialMessagesCount = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, messageContentSelector);

        // 4. Вводим запрос
        const textAreaSelector = 'textarea[aria-label="Поле для запросов"]';
        await page.waitForSelector(textAreaSelector, { timeout: 15000 });
        await page.click(textAreaSelector); // Focus
        await delay(500);

        const bookPrompts: Record<string, string> = {
            'algebra': 'Выведите из учебника по алгебре.',
            'geometry': 'Выведите из учебника по геометрии.',
            'social_studies': 'Выведите из учебника по обществознанию.',
            'history': 'Выведите из учебника по истории.',
            'russian': 'Выведите из учебника по русскому языку.'
        };

        const prefix = bookPrompts[bookId] || `[${bookId}]`;
        const fullQuery = `${question}${prefix}`;
        // Набираем текст запроса как пользователь
        await page.keyboard.type(fullQuery, { delay: 10 });
        await delay(1000);

        // 5. Отправляем запрос
        const submitSelector = 'button[aria-label="Отправить"]';
        try {
            const submitHandle = await page.$(submitSelector);
            if (submitHandle) {
                const isDisabled = await page.evaluate((el: any) => el.disabled, submitHandle);
                if (!isDisabled) {
                    await submitHandle.click();
                } else {
                    await page.keyboard.press('Enter');
                }
            } else {
                await page.keyboard.press('Enter');
            }
        } catch (e) {
            console.warn("[homework.ask] Ошибка взаимодействия с кнопкой отправки, жмем Enter.");
            await page.keyboard.press('Enter');
        }

        // Ждем пока появится новое сообщение
        let newMessagesCount = initialMessagesCount;
        for (let i = 0; i < 30; i++) {
            await delay(1000);
            newMessagesCount = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, messageContentSelector);
            if (newMessagesCount > initialMessagesCount) {
                break;
            }
        }

        if (newMessagesCount <= initialMessagesCount) {
            console.warn("[homework.ask] Новое сообщение не появилось, попытаемся прочитать последнее.");
        }

        // 6. Ждем генерации ответа
        console.log("[homework.ask] Ожидание завершения генерации NotebookLM...");
        let lastLength = 0;
        let stableCount = 0;

        while (true) {
            await delay(1000);
            const currentText = await page.evaluate((sel: string) => {
                const els = document.querySelectorAll(sel);
                if (els.length === 0) return "";
                // Берем текст последнего сообщения
                return els[els.length - 1].textContent || "";
            }, messageContentSelector);

            if (currentText.length > 0 && currentText.length === lastLength) {
                stableCount++;
                // Ждём дольше — 10 секунд без изменений для уверенности (особенно важно для математики)
                if (stableCount >= 10) {
                    break;
                }
            } else {
                lastLength = currentText.length;
                stableCount = 0;
            }
        }

        await delay(2000); // Дополнительная пауза для кнопки копирования

        // 7. Нажимаем кнопку копирования последнего ответа
        const copyButtonSelector = 'button[aria-label="Копировать ответ модели в буфер обмена"]';
        try {
            await page.waitForSelector(copyButtonSelector, { timeout: 10000 });
            await page.evaluate((sel: string) => {
                const btns = document.querySelectorAll(sel);
                if (btns.length > 0) {
                    (btns[btns.length - 1] as HTMLElement).click();
                }
            }, copyButtonSelector);
            await delay(1000); // Ждем копирования в буфер
        } catch (e) {
            console.warn("[homework.ask] Кнопка копирования не найдена.");
        }

        // 8. Читаем из буфера обмена
        let clipboardText = await page.evaluate(async () => {
            try {
                return await navigator.clipboard.readText();
            } catch (e) {
                return null;
            }
        });

        if (clipboardText && clipboardText.trim().length > 0) {
            return clipboardText.trim();
        }

        console.warn("[homework.ask] Ошибка чтения буфера обмена, извлекаем текст из DOM.");
        // Fallback на чтение из DOM
        const resultText = await page.evaluate((sel: string) => {
            const els = document.querySelectorAll(sel);
            if (els.length === 0) return "";
            return (els[els.length - 1] as HTMLElement).innerText || "";
        }, messageContentSelector);

        return resultText.trim();
    } catch (err: any) {
        throw new Error(`Ошибка при запросе к NotebookLM через браузер: ${err.message}`);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * Генерирует SVG код рисунка по тексту геометрической задачи при помощи LLM.
 *
 * @param taskText - Текст условия задачи.
 * @returns Строка с кодом SVG чертежа.
 * @example
 * const result = await generateSVG("В треугольнике ABC угол C равен 90 градусов...");
 */
export async function generateSVG(taskText: string): Promise<string> {
    const key = getApiKey();
    const ai = new GoogleGenAI({ apiKey: key });
    const model = 'gemini-3-flash-preview';

    const promptPath = path.join(__dirname, 'prompts', 'generate_svg.md');
    try {
        const systemInstruction = await fs.readFile(promptPath, 'utf-8');

        const response = await ai.models.generateContent({
            model: model,
            contents: taskText,
            config: {
                systemInstruction: systemInstruction,
            }
        });

        const text = response.text || "";

        // Попытка извлечь чистый SVG код, если модель обернула его в markdown
        const svgMatch = text.match(/```(?:xml|svg)?\s*([\s\S]*?)```/i);
        if (svgMatch && svgMatch[1]) {
            return svgMatch[1].trim();
        }

        return text.trim();
    } catch (err: any) {
        throw new Error(`Ошибка генерации SVG: ${err.message}`);
    }
}

/**
 * Форматирует готовое задание в строгий текстовый формат для принтера
 * и сохраняет его в .txt файл.
 *
 * @param taskContent - Содержимое выполненной задачи (с рисунком, решением и т.п.).
 * @param fileName - Название файла для сохранения в директории агента (например, task_156.txt).
 * @returns Сообщение об успешном выполнении и отформатированный текст.
 * @example
 * const result = await formatHomework("Дано: ... Решение: ... Ответ: ...", "task_156.txt");
 */
export async function formatHomework(taskContent: string, fileName: string): Promise<string> {
    const key = getApiKey();
    const ai = new GoogleGenAI({ apiKey: key });
    const model = 'gemini-flash-latest';

    const promptPath = path.join(__dirname, 'prompts', 'format_homework.md');
    try {
        const systemInstruction = await fs.readFile(promptPath, 'utf-8');
        const requestText = "Форматируй этот текст как ученик: " + taskContent;

        const response = await ai.models.generateContent({
            model: model,
            contents: requestText,
            config: {
                systemInstruction: systemInstruction,
            }
        });

        const formattedText = response.text || "";

        // Сохраняем в текущую рабочую директорию (сандбокс)
        const targetPath = path.resolve(process.cwd(), fileName);
        await fs.writeFile(targetPath, formattedText, 'utf-8');

        return `Задание успешно отформатировано и сохранено в файл: ${targetPath}\n\n[Результат форматирования]:\n${formattedText}`;
    } catch (err: any) {
        throw new Error(`Ошибка форматирования задания: ${err.message}`);
    }
}
