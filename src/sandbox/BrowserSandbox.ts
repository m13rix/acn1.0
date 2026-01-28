/**
 * Browser Sandbox Manager
 * 
 * Executes agent code in a Puppeteer browser instance.
 */

// Use puppeteer-extra with stealth plugin
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { ExecutionResult, LoadedTool } from '../types/index.js';
import type { ISandbox } from './interfaces.js';
import { getMinimalHtml } from '../utils/minimalHtml.js';

// Add the stealth plugin
puppeteer.use(StealthPlugin());

const __dirname = dirname(fileURLToPath(import.meta.url));
// Use resolve to handle potential relative path issues and ensure absolute path
const PROJECT_ROOT = resolve(__dirname, '..', '..');

// Persistent profile directory - ensure it's absolute
const PROFILE_DIR = resolve(PROJECT_ROOT, 'browser-profile');

export class BrowserSandbox implements ISandbox {
    public readonly id: string;
    public readonly directory: string;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private initialized = false;
    private consoleLogs: string[] = [];

    constructor(baseDir?: string) {
        this.id = randomUUID().slice(0, 8);
        this.directory = join(baseDir || join(PROJECT_ROOT, 'sandboxes'), `session-${this.id}`);
    }

    async initialize(tools: LoadedTool[], skillsTable?: string): Promise<void> {
        // Create sandbox directory
        await mkdir(this.directory, { recursive: true });

        // Create profile directory if it doesn't exist
        await mkdir(PROFILE_DIR, { recursive: true });

        // Launch browser with persistent profile and anti-bot flags
        this.browser = await puppeteer.launch({
            headless: false, // Show browser
            userDataDir: PROFILE_DIR, // Persistent profile
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled', // Help evade detection
                '--start-maximized'
            ],
            ignoreDefaultArgs: ['--enable-automation'], // Hide "Chrome is being controlled..." bar
            defaultViewport: null // Use window size
        }) as unknown as Browser;

        const pages = await this.browser.pages();
        this.page = pages.length > 0 ? pages[0] : await this.browser.newPage();

        // Setup console capture
        this.page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();

            // Filter: only keep log and error
            if (type === 'log' || type === 'error') {
                this.consoleLogs.push(`[${type}] ${text}`);

                // Limit: keep last 20 messages
                if (this.consoleLogs.length > 20) {
                    this.consoleLogs.shift();
                }
            }
        });

        // Capture page errors
        this.page.on('pageerror', err => {
            this.consoleLogs.push(`[error] ${err.toString()}`);
            if (this.consoleLogs.length > 20) {
                this.consoleLogs.shift();
            }
        });

        this.initialized = true;

        // Initial navigation to Google
        await this.page.goto('https://google.com');
    }

    getDescription(): string {
        return `## Sandbox (Browser)

The agent runs in a browser environment (Puppeteer).
- Tools are NOT available.
- The environment is persistent (same page/browser session).

### Action
The content of actions is JavaScript code executed in the browser context.
- Use \`console.log(...)\` to produce observations.
- Code runs directly on the current page via \`page.evaluate()\`.
- Before providing the code, the system will update the context with a screenshot of the current page.

### CLI
The content of cli tags are browser navigation commands.
- \`goto <url>\`: Navigate to a URL
- \`back\`: Go back in history
- \`forward\`: Go forward in history
- \`refresh\`: Reload the page`;
    }

    async execute(code: string): Promise<ExecutionResult> {
        if (!this.initialized || !this.page) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        this.consoleLogs = []; // Reset logs

        try {
            // Wrap code to return logs if needed, but we catch them via event listener
            // We wrap in an async function to allow await
            // We basically eval the code in the page

            // Note: page.evaluate takes a function or string.
            // If we pass string, it evaluates it.

            const result = await this.page.evaluate(code);

            // Wait for page to stabilize after code execution
            await this.waitForStable();

            let output = this.consoleLogs.join('\n');
            if (result !== undefined && result !== null) {
                output += `\nReturn value: ${JSON.stringify(result)}`;
            }

            if (!output.trim()) {
                output = '(executed successfully, no console output)';
            }

            // Save page context (minimal HTML) after execution
            await this.savePageContext();

            return {
                success: true,
                output: output.trim(),
                filename: 'browser_script.js' // Dummy filename
            };

        } catch (error: any) {
            const output = this.consoleLogs.join('\n');

            // Save page context even on error
            await this.savePageContext();

            return {
                success: false,
                output: output,
                error: error.message || String(error)
            };
        }
    }

    async executeCli(command: string): Promise<ExecutionResult> {
        if (!this.initialized || !this.page) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }

        const parts = command.trim().split(/\s+/);
        const cmd = parts[0]?.toLowerCase();
        const args = parts.slice(1).join(' ');

        try {
            switch (cmd) {
                case 'goto':
                    if (!args) throw new Error('Usage: goto <url>');
                    let url = args;
                    if (!url.startsWith('http')) url = 'https://' + url;
                    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: `Navigated to ${url}` };

                case 'back':
                    await this.page.goBack();
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: 'Went back' };

                case 'forward':
                    await this.page.goForward();
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: 'Went forward' };

                case 'refresh':
                    await this.page.reload();
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: 'Reloaded page' };

                default:
                    return {
                        success: false,
                        output: '',
                        error: `Unknown browser command: ${cmd}. Available: goto, back, forward, refresh`
                    };
            }
        } catch (error: any) {
            return {
                success: false,
                output: '',
                error: `Browser command failed: ${error.message}`
            };
        }
    }

    async cleanup(): Promise<void> {
        if (this.browser) {
            // Don't delete profile, only close browser
            await this.browser.close();
            this.browser = null;
            this.page = null;
        }

        try {
            await rm(this.directory, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    }

    /**
     * Wait for the page to stabilize (network idle + small delay)
     */
    private async waitForStable(): Promise<void> {
        if (!this.page) return;

        try {
            // Wait for network to be idle (no requests for 500ms)
            // Set a reasonable timeout so we don't block forever if there's polling
            await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 });
        } catch (e) {
            // Ignore timeout - just means network didn't settle, we proceed anyway
        }

        // Small fixed delay for layout/paint
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    private async savePageContext(): Promise<void> {
        if (!this.page) return;

        try {
            // Get minimal HTML of current page
            const minimalHtml = await getMinimalHtml(this.page);

            // Encode to base64 (matching the format expected by providers)
            const base64Html = Buffer.from(minimalHtml, 'utf-8').toString('base64');

            // Write to .acn-files.json
            // Format: [{ content: string (base64), filename: string }]
            const files = [{
                content: base64Html,
                filename: 'page.html'
            }];

            await writeFile(
                join(this.directory, '.acn-files.json'),
                JSON.stringify(files),
                'utf-8'
            );
        } catch (error) {
            console.error('Failed to save page context:', error);
        }
    }
}
