/**
 * Browser Sandbox Manager
 *
 * Runs browser actions through a local WebSocket bridge connected to the
 * user's installed Chrome extension. This keeps the sandbox contract close to
 * the previous Puppeteer implementation without launching a separate browser.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import type { AgentMemoryConfig, ExecutionResult, LoadedTool } from '../types/index.js';
import type { ISandbox } from './interfaces.js';
import { CaptchaAutomation } from './CaptchaAutomation.js';
import {
    COMPLETION_SIGNAL_END,
    COMPLETION_SIGNAL_START,
    LEGACY_COMPLETION_FUNCTION,
    PRIMARY_COMPLETION_FUNCTION,
} from '../core/completion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..', '..');
const DEFAULT_BRIDGE_HOST = '127.0.0.1';
const DEFAULT_BRIDGE_PORT = 17321;
const DEFAULT_SESSION_URL = 'https://google.com';
const MAX_CONSOLE_LOGS = 20;

type JsonObject = Record<string, unknown>;

interface BridgeResponse {
    type: 'response';
    id: string;
    ok: boolean;
    result?: unknown;
    error?: string;
}

interface BridgeEvent {
    type: 'event';
    event: string;
    level?: string;
    text?: string;
    tabId?: number;
}

interface BrowserTabInfo {
    id?: number;
    title?: string;
    url?: string;
    active?: boolean;
    windowId?: number;
    index?: number;
}

interface StartSessionResult {
    tabId?: number;
    tab?: BrowserTabInfo;
}

interface EvaluateResult {
    logs?: string[];
    valueText?: string;
    error?: string;
    value?: EvaluateResult;
}

interface SnapshotElementSummary {
    tag?: string;
    id?: string;
    role?: string;
    name?: string;
    type?: string;
    ariaLabel?: string;
    placeholder?: string;
    text?: string;
    value?: string;
    contentEditable?: string;
    disabled?: boolean;
    readonly?: boolean;
    rect?: { x: number; y: number; width: number; height: number };
}

interface SnapshotResult {
    html?: string;
    title?: string;
    url?: string;
    activeElement?: SnapshotElementSummary | null;
    viewport?: { width: number; height: number; scrollX: number; scrollY: number };
    visibleText?: string;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

interface CaptchaResponseField {
    selector: string;
    name: string;
    id: string;
    valueLength: number;
}

interface CaptchaFrameSummary {
    type: string;
    url: string;
    isChecked?: boolean;
    isSolved?: boolean;
    isVisible?: boolean;
}

interface CaptchaPageStatus {
    responseFields: CaptchaResponseField[];
    iframes: Array<{ title: string; src: string; visible: boolean }>;
    widgets: Array<{ type: string; sitekey: string; selector: string }>;
    hasSolvedToken: boolean;
}

export class BrowserSandbox implements ISandbox {
    public readonly id: string;
    public readonly directory: string;
    private readonly host: string;
    private readonly port: number;
    private wss: WebSocketServer | null = null;
    private socket: WebSocket | null = null;
    private initialized = false;
    private activeTabId: number | undefined;
    private consoleLogs: string[] = [];
    private pending = new Map<string, PendingRequest>();
    private connectionWaiters: Array<() => void> = [];
    private lastVisibleText = '';

    constructor(baseDir?: string) {
        this.id = randomUUID().slice(0, 8);
        this.directory = join(baseDir || join(PROJECT_ROOT, 'sandboxes'), `session-${this.id}`);
        this.host = process.env.TELOS_BROWSER_CONTROL_HOST || DEFAULT_BRIDGE_HOST;
        this.port = Number(process.env.TELOS_BROWSER_CONTROL_PORT || DEFAULT_BRIDGE_PORT);
    }

    async initialize(_tools: LoadedTool[], _memoryConfig?: AgentMemoryConfig): Promise<void> {
        await mkdir(this.directory, { recursive: true });
        await this.startBridgeServer();
        await this.waitForExtensionConnection();

        const session = await this.sendCommand<StartSessionResult>('startSession', {
            url: process.env.TELOS_BROWSER_CONTROL_START_URL || DEFAULT_SESSION_URL,
            sessionId: this.id
        }, 30000);

        this.activeTabId = session.tabId ?? session.tab?.id;
        this.initialized = true;
        await this.waitForStable();
        await this.savePageContext();
    }

    getDescription(): string {
        return `## Browser Sandbox

\`action\` runs JavaScript in the current tab of the user's real Chrome browser through the Telos Browser Control extension; use \`console.log(...)\` for observations. Tools are unavailable here and browser state is the user's actual profile.
The current page is provided as compressed, annotated HTML in \`page.html\`. It preserves visible text, forms, labels, controls, contenteditables, ARIA, iframe summaries, bounding boxes, focusability, and the active element when available.
Inside \`action\`, optional helpers are available at \`window.__telos\`: \`visible(el)\`, \`textOf(el)\`, \`rectOf(el)\`, \`summarizeElement(el)\`, \`setNativeValue(el, value)\`, \`fireInput(el)\`, and \`candidates(query)\`. These helpers are convenience snippets; arbitrary DOM JavaScript remains the primary interface.
\`cli\` accepts navigation commands: \`goto <url>\`, \`back\`, \`forward\`, \`refresh\`.
\`cli\` also accepts tab commands: \`tabs\` (list open tabs), \`switch <tabId>\`, \`open <url>\`, \`close [tabId]\`, \`current\`.
\`cli\` also accepts captcha commands: \`captcha detect\` (find CAPTCHA widgets and verification status), \`captcha solve [selector]\` (autonomously click/solve reCAPTCHA, hCaptcha, Turnstile, and image/audio CAPTCHAs), \`captcha solve-audio <url>\` (transcribe and submit an audio CAPTCHA), \`captcha wait [timeoutMs]\` (wait for verification after a solve attempt).`;
    }

    async execute(code: string): Promise<ExecutionResult> {
        this.assertInitialized();
        try {
            const result = await this.sendCommand<EvaluateResult>('evaluate', {
                tabId: this.activeTabId,
                code: this.buildEvaluationCode(code)
            }, 60000);

            await this.waitForStable();
            const snapshot = await this.savePageContext();

            const evaluation = this.unwrapEvaluateResult(result);
            const logs = Array.isArray(evaluation.logs) ? evaluation.logs.filter((line): line is string => typeof line === 'string' && line.trim().length > 0) : [];
            let output = logs.join('\n');
            const returnText = this.formatReturnValue(evaluation);
            if (returnText) {
                output += output ? `\n${returnText}` : returnText;
            }

            if (evaluation.error) {
                const errorLine = `Error: ${evaluation.error}`;
                output += output ? `\n${errorLine}` : errorLine;
                output = this.appendPageState(output, snapshot);
                return {
                    success: false,
                    output: output.trim(),
                    error: evaluation.error
                };
            }

            if (!output.trim()) {
                output = '(executed successfully, no console output)';
            }
            output = this.appendPageState(output, snapshot);

            return {
                success: true,
                output: output.trim(),
                filename: 'browser_script.js'
            };
        } catch (error: any) {
            const snapshot = await this.savePageContext();

            return {
                success: false,
                output: this.appendPageState(error.message || String(error), snapshot),
                error: error.message || String(error)
            };
        }
    }

    async executeCli(command: string): Promise<ExecutionResult> {
        this.assertInitialized();

        const trimmed = command.trim();
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0]?.toLowerCase();
        const args = parts.slice(1).join(' ');

        try {
            switch (cmd) {
                case 'goto': {
                    if (!args) throw new Error('Usage: goto <url>');
                    const url = this.normalizeUrl(args);
                    const tab = await this.sendCommand<BrowserTabInfo>('navigate', { tabId: this.activeTabId, url }, 30000);
                    this.activeTabId = tab.id ?? this.activeTabId;
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: `Navigated to ${url}` };
                }

                case 'back':
                    await this.sendCommand('back', { tabId: this.activeTabId }, 30000);
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: 'Went back' };

                case 'forward':
                    await this.sendCommand('forward', { tabId: this.activeTabId }, 30000);
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: 'Went forward' };

                case 'refresh':
                case 'reload':
                    await this.sendCommand('refresh', { tabId: this.activeTabId }, 30000);
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: 'Reloaded page' };

                case 'tabs':
                case 'list-tabs': {
                    const tabs = await this.sendCommand<BrowserTabInfo[]>('listTabs', {}, 10000);
                    return { success: true, output: this.formatTabs(tabs) };
                }

                case 'switch':
                case 'tab': {
                    const tabId = Number(parts[1]);
                    if (!Number.isInteger(tabId)) throw new Error('Usage: switch <tabId>');
                    const tab = await this.sendCommand<BrowserTabInfo>('switchTab', { tabId }, 10000);
                    this.activeTabId = tab.id;
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: `Switched to tab ${tab.id}: ${tab.title || tab.url || ''}`.trim() };
                }

                case 'open':
                case 'new-tab': {
                    const url = args ? this.normalizeUrl(args) : DEFAULT_SESSION_URL;
                    const tab = await this.sendCommand<BrowserTabInfo>('openTab', { url, active: true }, 30000);
                    this.activeTabId = tab.id;
                    await this.waitForStable();
                    await this.savePageContext();
                    return { success: true, output: `Opened tab ${tab.id}: ${url}` };
                }

                case 'close': {
                    const tabId = parts[1] ? Number(parts[1]) : this.activeTabId;
                    if (!Number.isInteger(tabId)) throw new Error('Usage: close [tabId]');
                    await this.sendCommand('closeTab', { tabId }, 10000);
                    if (tabId === this.activeTabId) {
                        const tab = await this.sendCommand<BrowserTabInfo>('getCurrentTab', {}, 10000);
                        this.activeTabId = tab.id;
                    }
                    await this.savePageContext();
                    return { success: true, output: `Closed tab ${tabId}` };
                }

                case 'current': {
                    const tab = await this.sendCommand<BrowserTabInfo>('getCurrentTab', { tabId: this.activeTabId }, 10000);
                    this.activeTabId = tab.id ?? this.activeTabId;
                    return { success: true, output: this.formatTabs([tab]) };
                }

                case 'captcha': {
                    const subCmd = parts[1]?.toLowerCase();
                    switch (subCmd) {
                        case 'detect':
                            return await this.captchaDetect();
                        case 'solve': {
                            const selector = parts.slice(2).join(' ').trim() || undefined;
                            return await this.captchaSolve(selector);
                        }
                        case 'solve-audio': {
                            const audioUrl = parts.slice(2).join(' ').trim();
                            if (!audioUrl) return { success: false, output: '', error: 'Usage: captcha solve-audio <url>' };
                            return await this.captchaSolveAudio(audioUrl);
                        }
                        case 'wait': {
                            const timeoutMs = parts[2] ? Number(parts[2]) : 120000;
                            if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
                                return { success: false, output: '', error: 'Usage: captcha wait [timeoutMs]' };
                            }
                            return await this.captchaWaitForVerification(timeoutMs);
                        }
                        default:
                            return {
                                success: false,
                                output: '',
                                error: 'Usage: captcha detect | captcha wait [timeoutMs] | captcha solve [selector] | captcha solve-audio <url>'
                            };
                    }
                }

                default:
                    return {
                        success: false,
                        output: '',
                        error: `Unknown browser command: ${cmd}. Available: goto, back, forward, refresh, tabs, switch, open, close, current, captcha`
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

    parseSearchReplace(_content: string): Array<{ search: string; replace: string }> {
        return [];
    }

    async applySearchReplace(_filename: string, _edits: Array<{ search: string; replace: string }>): Promise<ExecutionResult> {
        return {
            success: false,
            output: '',
            error: 'File editing is not supported in browser sandbox'
        };
    }

    async cleanup(): Promise<void> {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error('Browser sandbox is shutting down'));
        }
        this.pending.clear();

        try {
            if (this.socket?.readyState === WebSocket.OPEN) {
                await this.sendCommand('endSession', { tabId: this.activeTabId, sessionId: this.id }, 3000);
            }
        } catch {
            // The real browser should stay open even if session cleanup cannot be delivered.
        }

        this.socket?.close();
        this.socket = null;

        await new Promise<void>(resolve => {
            if (!this.wss) {
                resolve();
                return;
            }

            this.wss.close(() => resolve());
            this.wss = null;
        });

        try {
            await rm(this.directory, { recursive: true, force: true });
        } catch {
            // Ignore
        }
    }

    private async startBridgeServer(): Promise<void> {
        if (this.wss) return;

        await new Promise<void>((resolvePromise, reject) => {
            const server = new WebSocketServer({ host: this.host, port: this.port });
            this.wss = server;

            server.once('listening', () => resolvePromise());
            server.once('error', error => {
                this.wss = null;
                reject(new Error(`Failed to start browser-control bridge on ws://${this.host}:${this.port}: ${error.message}`));
            });

            server.on('connection', socket => {
                this.attachSocket(socket);
            });
        });
    }

    private attachSocket(socket: WebSocket): void {
        this.socket?.close();
        this.socket = socket;

        socket.on('message', data => this.handleMessage(data.toString()));
        socket.on('close', () => {
            if (this.socket === socket) {
                this.socket = null;
            }
        });
        socket.on('error', () => {
            if (this.socket === socket) {
                this.socket = null;
            }
        });

        for (const resolveConnection of this.connectionWaiters.splice(0)) {
            resolveConnection();
        }
    }

    private handleMessage(text: string): void {
        let message: unknown;
        try {
            message = JSON.parse(text);
        } catch {
            return;
        }

        if (!message || typeof message !== 'object') return;

        if (this.isBridgeResponse(message)) {
            const pending = this.pending.get(message.id);
            if (!pending) return;

            clearTimeout(pending.timer);
            this.pending.delete(message.id);

            if (message.ok) {
                pending.resolve(message.result);
            } else {
                pending.reject(new Error(message.error || 'Browser extension command failed'));
            }
            return;
        }

        if (this.isBridgeEvent(message)) return;
    }

    private async waitForExtensionConnection(): Promise<void> {
        if (this.socket?.readyState === WebSocket.OPEN) return;

        await new Promise<void>((resolvePromise, reject) => {
            const timer = setTimeout(() => {
                this.connectionWaiters = this.connectionWaiters.filter(waiter => waiter !== finish);
                reject(new Error(
                    `No Telos Browser Control extension connected to ws://${this.host}:${this.port}. ` +
                    'Load the unpacked extension from G:\\telos\\browser-control in Chrome and keep it enabled.'
                ));
            }, 45000);

            const finish = () => {
                clearTimeout(timer);
                resolvePromise();
            };

            this.connectionWaiters.push(finish);
        });
    }

    private sendCommand<T = unknown>(command: string, params: JsonObject = {}, timeoutMs = 30000): Promise<T> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            throw new Error(`Browser extension is not connected to ws://${this.host}:${this.port}`);
        }

        const id = randomUUID();
        const payload = JSON.stringify({
            type: 'command',
            id,
            command,
            params
        });

        return new Promise<T>((resolvePromise, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for browser extension command: ${command}`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: value => resolvePromise(value as T),
                reject,
                timer
            });

            socket.send(payload, error => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            });
        });
    }

    private assertInitialized(): void {
        if (!this.initialized) {
            throw new Error('Sandbox not initialized. Call initialize() first.');
        }
    }

    private async waitForStable(): Promise<void> {
        try {
            await this.sendCommand('waitForStable', { tabId: this.activeTabId }, 8000);
        } catch {
            await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
        }
    }

    private async savePageContext(): Promise<SnapshotResult | null> {
        try {
            const snapshot = await this.sendCommand<SnapshotResult>('snapshot', { tabId: this.activeTabId }, 10000);
            const html = snapshot.html || '';
            const header = this.formatSnapshotHeader(snapshot);
            const files = [{
                content: Buffer.from(`${header}${html}`, 'utf-8').toString('base64'),
                filename: 'page.html'
            }];

            await writeFile(
                join(this.directory, '.telos-files.json'),
                JSON.stringify(files),
                'utf-8'
            );

            return snapshot;
        } catch (error) {
            console.error('Failed to save browser page context:', error);
            return null;
        }
    }

    private formatSnapshotHeader(snapshot: SnapshotResult): string {
        const lines = [
            '<!-- Telos Browser Snapshot',
            `url: ${snapshot.url || ''}`,
            `title: ${snapshot.title || ''}`
        ];
        const active = this.formatElementSummary(snapshot.activeElement || null);
        if (active) lines.push(`activeElement: ${active}`);
        if (snapshot.viewport) {
            const { width, height, scrollX, scrollY } = snapshot.viewport;
            lines.push(`viewport: ${width}x${height} scroll=${scrollX},${scrollY}`);
        }
        lines.push('-->');
        return `${lines.join('\n')}\n`;
    }

    private appendPageState(output: string, snapshot: SnapshotResult | null): string {
        if (!snapshot) return output;

        const lines = [
            'Page state:',
            `- URL: ${snapshot.url || '(unknown)'}`,
            `- Title: ${snapshot.title || '(untitled)'}`
        ];

        const active = this.formatElementSummary(snapshot.activeElement || null);
        if (active) {
            lines.push(`- Active element: ${active}`);
        }

        const visibleText = (snapshot.visibleText || '').replace(/\s+/g, ' ').trim();
        if (visibleText) {
            const previous = this.lastVisibleText;
            this.lastVisibleText = visibleText;
            if (previous && previous !== visibleText) {
                lines.push(`- Visible text changed: ${this.summarizeTextChange(previous, visibleText)}`);
            } else if (!previous) {
                lines.push(`- Visible text sample: ${this.truncate(visibleText, 220)}`);
            }
        }

        const suffix = lines.join('\n');
        return output.trim() ? `${output.trim()}\n${suffix}` : suffix;
    }

    private formatElementSummary(element: SnapshotElementSummary | null): string {
        if (!element) return '';
        const parts = [element.tag?.toLowerCase()].filter(Boolean) as string[];
        if (element.id) parts.push(`#${element.id}`);
        if (element.role) parts.push(`role=${element.role}`);
        if (element.type) parts.push(`type=${element.type}`);
        if (element.name) parts.push(`name=${element.name}`);
        if (element.ariaLabel) parts.push(`aria="${this.truncate(element.ariaLabel, 80)}"`);
        if (element.placeholder) parts.push(`placeholder="${this.truncate(element.placeholder, 80)}"`);
        if (element.text) parts.push(`text="${this.truncate(element.text.replace(/\s+/g, ' '), 100)}"`);
        if (element.value) parts.push(`value="${this.truncate(element.value, 80)}"`);
        if (element.contentEditable) parts.push(`contenteditable=${element.contentEditable}`);
        if (element.disabled) parts.push('disabled');
        if (element.readonly) parts.push('readonly');
        if (element.rect) {
            parts.push(`rect=${Math.round(element.rect.x)},${Math.round(element.rect.y)},${Math.round(element.rect.width)}x${Math.round(element.rect.height)}`);
        }
        return parts.join(' ');
    }

    private summarizeTextChange(previous: string, current: string): string {
        if (current.includes(previous)) {
            return `added "${this.truncate(current.replace(previous, '').trim(), 180)}"`;
        }
        if (previous.includes(current)) {
            return `removed "${this.truncate(previous.replace(current, '').trim(), 180)}"`;
        }
        return `now "${this.truncate(current, 220)}"`;
    }

    private truncate(value: string, maxLength: number): string {
        return value.length > maxLength ? `${value.slice(0, maxLength)}...[truncated]` : value;
    }

    private normalizeUrl(input: string): string {
        if (/^[a-z][a-z\d+.-]*:/i.test(input)) {
            return input;
        }
        return `https://${input}`;
    }

    private formatReturnValue(result: EvaluateResult): string {
        if (!result) return '';
        if (result.valueText) {
            return `Return value: ${result.valueText}`;
        }
        return '';
    }

    private buildEvaluationCode(code: string): string {
        const completionBootstrap = `
const __telosCompletionSignal = {};
const __telosCompleteTask = (message) => {
  console.log('${COMPLETION_SIGNAL_START}' + JSON.stringify(String(message ?? '')) + '${COMPLETION_SIGNAL_END}');
  throw __telosCompletionSignal;
};
const ${PRIMARY_COMPLETION_FUNCTION} = __telosCompleteTask;
const ${LEGACY_COMPLETION_FUNCTION} = __telosCompleteTask;
`;

        return `${completionBootstrap}
try {
${code}
} catch (error) {
  if (error !== __telosCompletionSignal) {
    throw error;
  }
}`;
    }

    private unwrapEvaluateResult(result: EvaluateResult): EvaluateResult {
        return result.value && typeof result.value === 'object' ? result.value : result;
    }

    private formatTabs(tabs: BrowserTabInfo[]): string {
        if (!tabs.length) return '(no tabs found)';
        return tabs
            .map(tab => {
                const marker = tab.id === this.activeTabId || tab.active ? '*' : ' ';
                const id = tab.id ?? '?';
                const title = tab.title || '(untitled)';
                const url = tab.url || '';
                return `${marker} [${id}] ${title}${url ? ` - ${url}` : ''}`;
            })
            .join('\n');
    }

    private isBridgeResponse(message: object): message is BridgeResponse {
        const candidate = message as Partial<BridgeResponse>;
        return candidate.type === 'response' && typeof candidate.id === 'string' && typeof candidate.ok === 'boolean';
    }

    private isBridgeEvent(message: object): message is BridgeEvent {
        const candidate = message as Partial<BridgeEvent>;
        return candidate.type === 'event' && typeof candidate.event === 'string';
    }

    // CAPTCHA helpers

    /**
     * Detect CAPTCHAs on the current page by scanning for common CAPTCHA patterns.
     */
    private async captchaDetect(): Promise<ExecutionResult> {
        this.assertInitialized();
        this.consoleLogs = [];

        const detectScript = `
            (function() {
                const found = [];

                // reCAPTCHA v2
                const recaptchaEl = document.querySelector('.g-recaptcha, [data-sitekey]');
                const recaptchaIframe = document.querySelector('iframe[src*="google.com/recaptcha"]');
                if (recaptchaEl || recaptchaIframe) {
                    const sitekey = recaptchaEl?.getAttribute('data-sitekey') || '(from iframe)';
                    found.push({ type: 'recaptcha-v2', sitekey, element: recaptchaEl?.tagName || 'iframe' });
                }

                // hCaptcha
                const hcaptchaEl = document.querySelector('.h-captcha, [data-hcaptcha-sitekey]');
                const hcaptchaIframe = document.querySelector('iframe[src*="hcaptcha.com"]');
                if (hcaptchaEl || hcaptchaIframe) {
                    const sitekey = hcaptchaEl?.getAttribute('data-sitekey') || '(from iframe)';
                    found.push({ type: 'hcaptcha', sitekey, element: hcaptchaEl?.tagName || 'iframe' });
                }

                // Cloudflare Turnstile
                const turnstileEl = document.querySelector('.cf-turnstile, [data-turnstile-sitekey]');
                if (turnstileEl) {
                    const sitekey = turnstileEl.getAttribute('data-sitekey') || 'unknown';
                    found.push({ type: 'turnstile', sitekey, element: turnstileEl.tagName });
                }

                // Generic image CAPTCHAs - look for img elements near captcha-related containers
                const captchaKeywords = /captcha|verify|challenge|security.?code|human.?check/i;
                const allImages = document.querySelectorAll('img');
                for (const img of allImages) {
                    const src = img.src || '';
                    const alt = img.alt || '';
                    const id = img.id || '';
                    const className = img.className || '';
                    const parentText = img.parentElement?.textContent?.slice(0, 200) || '';
                    if (captchaKeywords.test(src) || captchaKeywords.test(alt) ||
                        captchaKeywords.test(id) || captchaKeywords.test(className) ||
                        captchaKeywords.test(parentText)) {
                        const selector = img.id ? '#' + img.id :
                            img.className ? 'img.' + img.className.split(' ')[0] :
                            'img[src*="' + (new URL(src, location.href).pathname.split('/').pop() || '') + '"]';
                        found.push({
                            type: 'image-captcha',
                            selector: selector,
                            src: src.length > 200 ? src.slice(0, 200) + '...' : src,
                            alt: alt,
                            dimensions: img.naturalWidth + 'x' + img.naturalHeight
                        });
                    }
                }

                // Also check for canvas-based CAPTCHAs
                const canvases = document.querySelectorAll('canvas');
                for (const canvas of canvases) {
                    const id = canvas.id || '';
                    const className = canvas.className || '';
                    const parentText = canvas.parentElement?.textContent?.slice(0, 200) || '';
                    if (captchaKeywords.test(id) || captchaKeywords.test(className) ||
                        captchaKeywords.test(parentText)) {
                        found.push({
                            type: 'canvas-captcha',
                            selector: canvas.id ? '#' + canvas.id : 'canvas.' + (canvas.className.split(' ')[0] || 'unknown'),
                            dimensions: canvas.width + 'x' + canvas.height
                        });
                    }
                }

                // Check input fields that look like CAPTCHA answer fields
                const inputs = document.querySelectorAll('input[type="text"]');
                for (const input of inputs) {
                    const name = input.getAttribute('name') || '';
                    const id = input.id || '';
                    const placeholder = input.getAttribute('placeholder') || '';
                    if (captchaKeywords.test(name) || captchaKeywords.test(id) || captchaKeywords.test(placeholder)) {
                        found.push({
                            type: 'captcha-input',
                            selector: input.id ? '#' + input.id : 'input[name="' + name + '"]',
                            placeholder: placeholder
                        });
                    }
                }

                return JSON.stringify(found, null, 2);
            })()
        `;

        try {
            const result = await this.sendCommand<EvaluateResult>('evaluate', {
                tabId: this.activeTabId,
                code: detectScript
            }, 15000);

            const value = typeof result?.valueText === 'string' ? result.valueText : '[]';

            let parsed: any[];
            try {
                parsed = JSON.parse(value);
            } catch {
                parsed = [];
            }

            const pageStatus = await this.readCaptchaPageStatus();
            const frameStatus = await this.readCaptchaFrameStatus();
            const statusOutput = this.formatCaptchaVerificationStatus(pageStatus, frameStatus);

            if (parsed.length === 0) {
                return { success: true, output: `No CAPTCHAs detected on the current page.\n${statusOutput}` };
            }

            let output = `Found ${parsed.length} CAPTCHA element(s):\n`;
            for (const item of parsed) {
                output += `\n- Type: ${item.type}`;
                if (item.sitekey) output += `\n  Sitekey: ${item.sitekey}`;
                if (item.selector) output += `\n  Selector: ${item.selector}`;
                if (item.src) output += `\n  Image src: ${item.src}`;
                if (item.dimensions) output += `\n  Dimensions: ${item.dimensions}`;
                if (item.placeholder) output += `\n  Placeholder: ${item.placeholder}`;
            }

            output += `\n\n${statusOutput}`;

            return { success: true, output };
        } catch (error: any) {
            return {
                success: false,
                output: '',
                error: `CAPTCHA detection failed: ${error.message}`
            };
        }
    }

    private createCaptchaAutomation(): CaptchaAutomation {
        return new CaptchaAutomation({
            tabId: this.activeTabId,
            sendCommand: (command, params, timeoutMs) => this.sendCommand(command, params ?? {}, timeoutMs),
            readPageStatus: () => this.readCaptchaPageStatus(),
            readFrameStatus: () => this.readCaptchaFrameStatus(),
            waitForStable: () => this.waitForStable()
        });
    }

    private async captchaSolve(selector?: string): Promise<ExecutionResult> {
        this.assertInitialized();
        const result = await this.createCaptchaAutomation().solve(selector);
        await this.savePageContext();
        return {
            success: result.success,
            output: result.output,
            error: result.error
        };
    }

    private async captchaSolveAudio(audioUrl: string): Promise<ExecutionResult> {
        this.assertInitialized();
        const result = await this.createCaptchaAutomation().solveAudioFromUrl(audioUrl);
        await this.savePageContext();
        return {
            success: result.success,
            output: result.output,
            error: result.error
        };
    }

    private async captchaWaitForVerification(timeoutMs: number): Promise<ExecutionResult> {
        this.assertInitialized();

        const deadline = Date.now() + timeoutMs;
        let lastPageStatus: CaptchaPageStatus | null = null;
        let lastFrameStatus: CaptchaFrameSummary[] = [];

        while (Date.now() <= deadline) {
            lastPageStatus = await this.readCaptchaPageStatus();
            lastFrameStatus = await this.readCaptchaFrameStatus();

            if (this.isCaptchaVerified(lastPageStatus, lastFrameStatus)) {
                await this.waitForStable();
                await this.savePageContext();
                return {
                    success: true,
                    output: `CAPTCHA verification detected.\n${this.formatCaptchaVerificationStatus(lastPageStatus, lastFrameStatus)}`
                };
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const pageStatus = lastPageStatus ?? await this.readCaptchaPageStatus();
        const frameStatus = lastFrameStatus.length ? lastFrameStatus : await this.readCaptchaFrameStatus();

        return {
            success: false,
            output: this.formatCaptchaVerificationStatus(pageStatus, frameStatus),
            error: `Timed out after ${timeoutMs}ms waiting for CAPTCHA verification. Run captcha solve again.`
        };
    }

    private async readCaptchaPageStatus(): Promise<CaptchaPageStatus> {
        const statusScript = `
            (function() {
                const responseSelector = [
                    'textarea[name="g-recaptcha-response"]',
                    'textarea#g-recaptcha-response',
                    'textarea[name="h-captcha-response"]',
                    'input[name="h-captcha-response"]',
                    'input[name="cf-turnstile-response"]',
                    'textarea[name="cf-turnstile-response"]'
                ].join(',');

                const selectorFor = el => {
                    if (el.id) return '#' + el.id;
                    const name = el.getAttribute('name');
                    if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
                    return el.tagName.toLowerCase();
                };

                const responseFields = Array.from(document.querySelectorAll(responseSelector)).map(el => ({
                    selector: selectorFor(el),
                    name: el.getAttribute('name') || '',
                    id: el.id || '',
                    valueLength: String(el.value || '').trim().length
                }));

                const iframes = Array.from(document.querySelectorAll('iframe'))
                    .map(frame => {
                        const rect = frame.getBoundingClientRect();
                        return {
                            title: frame.title || '',
                            src: frame.src || '',
                            visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
                        };
                    })
                    .filter(frame => /recaptcha|hcaptcha|turnstile|captcha/i.test(frame.title + ' ' + frame.src));

                const widgets = Array.from(document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], [data-hcaptcha-sitekey], [data-turnstile-sitekey]')).map(el => ({
                    type: el.classList.contains('h-captcha') || el.hasAttribute('data-hcaptcha-sitekey') ? 'hcaptcha' :
                        el.classList.contains('cf-turnstile') || el.hasAttribute('data-turnstile-sitekey') ? 'turnstile' : 'recaptcha',
                    sitekey: el.getAttribute('data-sitekey') || el.getAttribute('data-hcaptcha-sitekey') || el.getAttribute('data-turnstile-sitekey') || '',
                    selector: selectorFor(el)
                }));

                return JSON.stringify({
                    responseFields,
                    iframes,
                    widgets,
                    hasSolvedToken: responseFields.some(field => field.valueLength > 0)
                });
            })()
        `;

        const result = await this.sendCommand<EvaluateResult>('evaluate', {
            tabId: this.activeTabId,
            code: statusScript
        }, 10000);
        const value = typeof result?.valueText === 'string' ? result.valueText : '{}';
        const parsed = JSON.parse(value) as Partial<CaptchaPageStatus>;

        return {
            responseFields: parsed.responseFields ?? [],
            iframes: parsed.iframes ?? [],
            widgets: parsed.widgets ?? [],
            hasSolvedToken: Boolean(parsed.hasSolvedToken)
        };
    }

    private async readCaptchaFrameStatus(): Promise<CaptchaFrameSummary[]> {
        try {
            const frameResults = await this.sendCommand<Array<{ result?: Partial<CaptchaFrameSummary> }>>('findFrameInfo', {
                tabId: this.activeTabId
            }, 10000);

            return (frameResults ?? [])
                .map(frame => frame.result)
                .filter((result): result is Partial<CaptchaFrameSummary> => Boolean(result?.type))
                .map(result => ({
                    type: String(result.type),
                    url: String(result.url || ''),
                    isChecked: result.isChecked,
                    isSolved: result.isSolved,
                    isVisible: result.isVisible
                }));
        } catch {
            return [];
        }
    }

    private isCaptchaVerified(pageStatus: CaptchaPageStatus, frameStatus: CaptchaFrameSummary[]): boolean {
        return pageStatus.hasSolvedToken || frameStatus.some(frame => frame.isChecked === true || frame.isSolved === true);
    }

    private formatCaptchaVerificationStatus(pageStatus: CaptchaPageStatus, frameStatus: CaptchaFrameSummary[]): string {
        const verified = this.isCaptchaVerified(pageStatus, frameStatus);
        const detectedCount = pageStatus.widgets.length + pageStatus.iframes.length + frameStatus.length;
        const lines = [`Verification status: ${verified ? 'verified' : 'pending'}`];

        if (detectedCount === 0 && pageStatus.responseFields.length === 0) {
            lines.push('No CAPTCHA widgets or response fields were detected on the current page.');
            return lines.join('\n');
        }

        if (pageStatus.responseFields.length) {
            lines.push('Response fields:');
            for (const field of pageStatus.responseFields) {
                lines.push(`- ${field.selector}: ${field.valueLength > 0 ? `token present (${field.valueLength} chars)` : 'empty'}`);
            }
        }

        if (pageStatus.widgets.length) {
            lines.push('Widgets:');
            for (const widget of pageStatus.widgets) {
                lines.push(`- ${widget.type}${widget.sitekey ? ` sitekey=${widget.sitekey}` : ''} selector=${widget.selector}`);
            }
        }

        if (pageStatus.iframes.length) {
            lines.push('CAPTCHA iframes:');
            for (const frame of pageStatus.iframes) {
                lines.push(`- ${frame.title || '(untitled)'} visible=${frame.visible} src=${frame.src.slice(0, 120)}`);
            }
        }

        if (frameStatus.length) {
            lines.push('Frame status:');
            for (const frame of frameStatus) {
                lines.push(`- ${frame.type}: checked=${String(frame.isChecked)} solved=${String(frame.isSolved)} visible=${String(frame.isVisible)}`);
            }
        }

        return lines.join('\n');
    }
}
