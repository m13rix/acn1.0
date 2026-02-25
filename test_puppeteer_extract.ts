import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';

puppeteer.use(StealthPlugin());

async function test() {
    console.log("Starting safe DOM extraction debug run...");
    const PROFILE_DIR = path.resolve(process.cwd(), 'browser-profile');
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

        const context = browser.defaultBrowserContext();
        await context.overridePermissions('https://notebooklm.google.com', ['clipboard-read', 'clipboard-write']);

        await page.goto('https://notebooklm.google.com/notebook/b14102a9-29f2-4cf9-ad2a-10238008c138?authuser=1', { waitUntil: 'domcontentloaded', timeout: 60000 });

        const delay = (ms: number) => new Promise(res => setTimeout(res, ms));
        await delay(5000);

        const textAreaSelector = 'textarea';
        await page.waitForSelector(textAreaSelector, { timeout: 15000 });
        await page.click(textAreaSelector);

        const fullQuery = `Выведи текст задания 585 Выведите из учебника по алгебре.`;
        await page.keyboard.type(fullQuery, { delay: 10 });
        await delay(1000);

        await page.keyboard.press('Enter');

        let lastLength = 0;
        let stableCount = 0;
        const messageContentSelector = '.message-text-content';

        while (true) {
            await delay(1000);
            try {
                const currentText = await page.evaluate((sel: string) => {
                    const els = document.querySelectorAll(sel);
                    if (els.length === 0) return "";
                    return els[els.length - 1].textContent || "";
                }, messageContentSelector);

                if (currentText.length > 0 && currentText.length === lastLength) {
                    stableCount++;
                    if (stableCount >= 10) {
                        break;
                    }
                } else {
                    lastLength = currentText.length;
                    stableCount = 0;
                }
            } catch (e) {
                console.warn("DOM changed too fast, retrying evaluate...");
            }
        }

        console.log("Safe DOM extraction starting clipboard testing...");
        await delay(3000);

        try {
            const copyButtonSelector = 'button[aria-label="Копировать ответ модели в буфер обмена"]';
            await page.evaluate((sel: string) => {
                const btns = document.querySelectorAll(sel);
                if (btns.length > 0) {
                    (btns[btns.length - 1] as HTMLElement).click();
                }
            }, copyButtonSelector);
            await delay(2000); // 2 seconds for clipboard buffer completion
        } catch (e) {
            console.error("Copy button not found");
        }

        const clipboardText = await page.evaluate(async () => {
            try { return await navigator.clipboard.readText(); } catch (e) { return null; }
        });
        console.log("Clipboard:", clipboardText);

    } catch (e) {
        console.error("Error during puppeteer script:", e);
    } finally {
        await browser.close();
    }
}

test();
