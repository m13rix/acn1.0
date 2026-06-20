import sharp from 'sharp';
import { CaptchaSolver } from './CaptchaSolver.js';

type JsonObject = Record<string, unknown>;

interface Point {
    x: number;
    y: number;
}

interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface GridTileInfo {
    found: boolean;
    provider?: string;
    instruction?: string;
    rows?: number;
    cols?: number;
    mode?: 'square' | 'image';
    tileCount?: number;
    tiles?: Array<{ index: number; pageX: number; pageY: number; selected?: boolean }>;
    frameTiles?: Array<{ index: number; left: number; top: number; width: number; height: number; centerX: number; centerY: number }>;
    verifyPoint?: Point | null;
    audioButtonPoint?: Point | null;
    screenshotClip?: Rect;
    offset?: Point;
    promptTop?: number;
}

interface CaptchaTarget {
    type: string;
    action: string;
    x?: number;
    y?: number;
    isChecked?: boolean;
    isSolved?: boolean;
    isVisible?: boolean;
    iframeVisible?: boolean;
    gridRect?: Rect;
    verifyPoint?: Point | null;
    audioUrl?: string | null;
    rect?: Rect;
}

interface CaptchaTargetsResult {
    iframes: Array<{ title: string; src: string; rect: Rect & { left?: number; top?: number } }>;
    targets: CaptchaTarget[];
}

interface CaptchaPageStatus {
    hasSolvedToken: boolean;
    responseFields: Array<{ selector: string; valueLength: number }>;
}

interface CaptchaFrameSummary {
    type: string;
    isChecked?: boolean;
    isSolved?: boolean;
}

export interface CaptchaAutomationDeps {
    tabId: number | undefined;
    sendCommand<T = unknown>(command: string, params?: JsonObject, timeoutMs?: number): Promise<T>;
    readPageStatus(): Promise<CaptchaPageStatus>;
    readFrameStatus(): Promise<CaptchaFrameSummary[]>;
    waitForStable(): Promise<void>;
}

export interface CaptchaSolveResult {
    success: boolean;
    output: string;
    error?: string;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class CaptchaAutomation {
    private readonly solver: CaptchaSolver;

    constructor(private readonly deps: CaptchaAutomationDeps, solver?: CaptchaSolver) {
        this.solver = solver ?? CaptchaSolver.getInstance();
    }

    async solve(selector?: string): Promise<CaptchaSolveResult> {
        const lines: string[] = [];

        try {
            await this.scrollCaptchaIntoView(selector);
            await this.deps.waitForStable();

            if (await this.isVerified()) {
                return {
                    success: true,
                    output: 'CAPTCHA already verified.\n' + await this.formatStatus()
                };
            }

            const checkboxClicked = await this.clickCheckboxTarget(lines);
            if (checkboxClicked) {
                lines.push(`Clicked CAPTCHA checkbox at (${checkboxClicked.x.toFixed(1)}, ${checkboxClicked.y.toFixed(1)}).`);
                await sleep(1500);
            }

            if (await this.waitForVerification(8000)) {
                lines.push('Checkbox click produced a verification token.');
                return { success: true, output: lines.join('\n') + '\n' + await this.formatStatus() };
            }

            const challengeSolved = await this.solveVisibleChallenge(lines);
            if (challengeSolved) {
                lines.push('Completed visible CAPTCHA challenge.');
            }

            const verified = await this.waitForVerification(15000);
            const status = await this.formatStatus();
            if (verified) {
                return { success: true, output: lines.join('\n') + '\n' + status };
            }

            const genericSolved = await this.solveGenericImageCaptcha(lines);
            if (genericSolved && await this.waitForVerification(5000)) {
                return { success: true, output: lines.join('\n') + '\n' + await this.formatStatus() };
            }

            return {
                success: false,
                output: lines.join('\n') + '\n' + status,
                error: 'CAPTCHA could not be verified automatically after all solve attempts.'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                output: lines.join('\n') + '\n' + await this.formatStatus(),
                error: `CAPTCHA solve failed: ${message}`
            };
        }
    }

    async solveAudioFromUrl(audioUrl: string): Promise<CaptchaSolveResult> {
        const lines: string[] = [`Solving audio CAPTCHA from ${audioUrl}`];

        try {
            const fetched = await this.deps.sendCommand<{ data: string; mimeType: string }>('fetchUrl', { url: audioUrl }, 30000);
            const answer = await this.solver.solveAudioCaptcha(fetched.data, fetched.mimeType || 'audio/mp3');
            lines.push(`Audio transcription: ${answer}`);

            const targets = await this.getTargets();
            const audioInput = targets.targets.find(target => target.action === 'audio-input');
            if (audioInput?.rect) {
                await this.humanClick(audioInput.rect.x + 12, audioInput.rect.y + audioInput.rect.height / 2);
                await this.typeText(answer);
                const verify = targets.targets.find(target => target.action === 'click-verify');
                if (verify?.x !== undefined && verify?.y !== undefined) {
                    await this.humanClick(verify.x, verify.y);
                }
            } else {
                await this.deps.sendCommand('evaluate', {
                    tabId: this.deps.tabId,
                    code: `
                        (function() {
                            const input = document.querySelector('#audio-response, input[name="audio-response"], input[type="text"]');
                            if (!input) return false;
                            input.focus();
                            input.value = ${JSON.stringify(answer)};
                            input.dispatchEvent(new Event('input', { bubbles: true }));
                            input.dispatchEvent(new Event('change', { bubbles: true }));
                            const verify = document.getElementById('recaptcha-verify-button') ||
                                document.querySelector('.button-submit, .verify-button');
                            if (verify) verify.click();
                            return true;
                        })()
                    `
                }, 10000);
            }

            const verified = await this.waitForVerification(15000);
            const status = await this.formatStatus();
            if (verified) {
                return { success: true, output: lines.join('\n') + '\n' + status };
            }

            return {
                success: false,
                output: lines.join('\n') + '\n' + status,
                error: 'Audio CAPTCHA answer submitted but verification token was not detected.'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                success: false,
                output: lines.join('\n'),
                error: `Audio CAPTCHA solve failed: ${message}`
            };
        }
    }

    private async scrollCaptchaIntoView(selector?: string): Promise<void> {
        const code = `
            (function() {
                const selector = ${JSON.stringify(selector || '')};
                const candidates = selector
                    ? Array.from(document.querySelectorAll(selector))
                    : Array.from(document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, iframe[title="reCAPTCHA"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]'));
                for (const el of candidates) {
                    try {
                        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
                    } catch {
                        el.scrollIntoView();
                    }
                }
                return candidates.length;
            })()
        `;
        await this.deps.sendCommand('evaluate', { tabId: this.deps.tabId, code }, 10000);
        await sleep(400);
    }

    private async getTargets(): Promise<CaptchaTargetsResult> {
        try {
            return await this.deps.sendCommand<CaptchaTargetsResult>('getCaptchaTargets', { tabId: this.deps.tabId }, 15000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Unknown command: getCaptchaTargets')) {
                throw error;
            }
            return this.buildTargetsFallback();
        }
    }

    private async buildTargetsFallback(): Promise<CaptchaTargetsResult> {
        const iframeResult = await this.deps.sendCommand<{ value?: string }>('evaluate', {
            tabId: this.deps.tabId,
            code: `
                (function() {
                    return JSON.stringify(Array.from(document.querySelectorAll('iframe')).map(frame => {
                        const rect = frame.getBoundingClientRect();
                        return {
                            title: frame.title || '',
                            src: frame.src || '',
                            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, left: rect.left, top: rect.top }
                        };
                    }));
                })()
            `
        }, 10000);

        const iframes = JSON.parse(String(iframeResult?.value ?? '[]')) as CaptchaTargetsResult['iframes'];
        const frameInfos = await this.deps.sendCommand<Array<{ frameId?: number; result?: Record<string, unknown> }>>('findFrameInfo', {
            tabId: this.deps.tabId
        }, 15000);

        const targets: CaptchaTarget[] = [];
        for (const entry of frameInfos) {
            const info = entry.result;
            if (!info?.type) continue;

            const iframe = iframes.find(candidate => this.iframeMatchesFrameInfo(candidate, info));
            const iframeVisible = Boolean(
                iframe &&
                iframe.rect.width > 20 &&
                iframe.rect.height > 20
            );
            const offsetX = iframeVisible ? (iframe!.rect.left ?? iframe!.rect.x) : 0;
            const offsetY = iframeVisible ? (iframe!.rect.top ?? iframe!.rect.y) : 0;
            const checkboxRect = info.checkboxRect as { left: number; top: number; width: number; height: number } | undefined;
            const gridRect = info.gridRect as { left: number; top: number; width: number; height: number } | undefined;
            const verifyRect = info.verifyRect as { left: number; top: number; width: number; height: number } | undefined;

            if ((info.type === 'recaptcha-anchor' || info.type === 'hcaptcha-anchor') && checkboxRect) {
                targets.push({
                    type: String(info.type),
                    action: 'click-checkbox',
                    x: offsetX + checkboxRect.left + checkboxRect.width / 2,
                    y: offsetY + checkboxRect.top + checkboxRect.height / 2,
                    isChecked: info.isChecked === true,
                    iframeVisible
                });
            }

            if ((info.type === 'recaptcha-challenge' || info.type === 'hcaptcha-challenge') && gridRect) {
                targets.push({
                    type: String(info.type),
                    action: 'grid',
                    gridRect: {
                        x: offsetX + gridRect.left,
                        y: offsetY + gridRect.top,
                        width: gridRect.width,
                        height: gridRect.height
                    },
                    verifyPoint: verifyRect ? {
                        x: offsetX + verifyRect.left + verifyRect.width / 2,
                        y: offsetY + verifyRect.top + verifyRect.height / 2
                    } : null,
                    audioUrl: typeof info.audioUrl === 'string' ? info.audioUrl : null,
                    iframeVisible
                });
            }
        }

        return { iframes, targets };
    }

    private iframeMatchesFrameInfo(iframe: { src?: string; title?: string }, frameInfo: Record<string, unknown>): boolean {
        const src = iframe.src || '';
        const url = String(frameInfo.url || '');
        const type = String(frameInfo.type || '');
        if (!src && !url) return false;

        if (type === 'recaptcha-anchor') {
            return (src.includes('recaptcha') && src.includes('anchor')) ||
                iframe.title === 'reCAPTCHA';
        }
        if (type === 'recaptcha-challenge') {
            return src.includes('recaptcha') && src.includes('bframe');
        }
        if (type === 'hcaptcha-anchor') {
            return src.includes('hcaptcha.com') && !src.includes('challenge');
        }
        if (type === 'hcaptcha-challenge') {
            return src.includes('hcaptcha.com') && src.includes('challenge');
        }
        if (type === 'turnstile') {
            return src.includes('challenges.cloudflare.com');
        }
        if (src && url) {
            return src.split('?')[0] === url.split('?')[0];
        }
        return false;
    }

    private async clickCheckboxTarget(lines: string[]): Promise<Point | null> {
        const { targets, iframes } = await this.getTargets();
        let checkbox = targets.find(target =>
            target.action === 'click-checkbox' &&
            !target.isChecked &&
            !target.isSolved &&
            typeof target.x === 'number' &&
            typeof target.y === 'number'
        );

        if (checkbox?.x !== undefined && checkbox?.y !== undefined && checkbox.x < 80 && checkbox.y < 80) {
            const anchorFrame = iframes.find(frame =>
                frame.title === 'reCAPTCHA' ||
                (frame.src.includes('recaptcha') && frame.src.includes('anchor'))
            ) || iframes.find(frame => frame.src.includes('hcaptcha.com')) ||
                iframes.find(frame => frame.src.includes('challenges.cloudflare.com'));

            if (anchorFrame) {
                const left = anchorFrame.rect.left ?? anchorFrame.rect.x;
                const top = anchorFrame.rect.top ?? anchorFrame.rect.y;
                checkbox = {
                    ...checkbox,
                    x: left + checkbox.x,
                    y: top + checkbox.y
                };
                lines.push(`Adjusted checkbox coordinates using iframe at (${left.toFixed(1)}, ${top.toFixed(1)}).`);
            }
        }

        if (!checkbox || checkbox.x === undefined || checkbox.y === undefined) {
            lines.push('No unchecked CAPTCHA checkbox target found.');
            return null;
        }

        await this.humanClick(checkbox.x, checkbox.y);
        return { x: checkbox.x, y: checkbox.y };
    }

    private async solveVisibleChallenge(lines: string[]): Promise<boolean> {
        for (let round = 0; round < 6; round += 1) {
            const gridInfo = await this.getGridTiles();
            if (!gridInfo.found || !gridInfo.tiles?.length) {
                if (round === 0) {
                    lines.push('No image-grid challenge detected after checkbox click.');
                }
                break;
            }

            lines.push(`Image-grid round ${round + 1}: ${gridInfo.rows}x${gridInfo.cols} "${gridInfo.instruction || 'unknown'}" (${gridInfo.mode}).`);
            try {
                const roundResult = await this.solveImageGridRound(gridInfo, lines);
                if (roundResult && await this.waitForVerification(8000)) {
                    return true;
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                lines.push(`Image-grid round ${round + 1} failed: ${message}`);
            }

            await sleep(1500);
        }

        return this.tryAudioFallback(lines);
    }

    private async getGridTiles(): Promise<GridTileInfo> {
        try {
            return await this.deps.sendCommand<GridTileInfo>('getGridTiles', { tabId: this.deps.tabId }, 15000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Unknown command: getGridTiles')) {
                throw error;
            }
            return { found: false };
        }
    }

    private async annotateGridScreenshot(
        base64: string,
        frameTiles: GridTileInfo['frameTiles'],
        promptTop: number
    ): Promise<string> {
        if (!frameTiles?.length) return base64;

        const image = sharp(Buffer.from(base64, 'base64'));
        const metadata = await image.metadata();
        const width = metadata.width || 400;
        const height = metadata.height || 400;

        const labels = frameTiles.map(tile => {
            const x = tile.left + 8;
            const y = tile.top - promptTop + 28;
            return `<text x="${x}" y="${y}" font-size="28" font-family="Arial" font-weight="700" fill="#ff1744" stroke="#ffffff" stroke-width="3">${tile.index}</text>`;
        }).join('');

        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`;
        const annotated = await image
            .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
            .png()
            .toBuffer();

        return annotated.toString('base64');
    }

    private async solveImageGridRound(gridInfo: GridTileInfo, lines: string[]): Promise<boolean> {
        const clip = gridInfo.screenshotClip;
        if (!clip || !gridInfo.tiles?.length || !gridInfo.rows || !gridInfo.cols || !gridInfo.tileCount) {
            throw new Error('Grid tile metadata is incomplete');
        }

        const screenshot = await this.deps.sendCommand<{ data: string }>('captureScreenshot', {
            tabId: this.deps.tabId,
            clip: {
                x: Math.max(0, clip.x),
                y: Math.max(0, clip.y),
                width: Math.max(1, clip.width),
                height: Math.max(1, clip.height)
            }
        }, 20000);

        const annotated = await this.annotateGridScreenshot(
            screenshot.data,
            gridInfo.frameTiles,
            gridInfo.promptTop ?? 0
        );

        const matches = await this.solver.solveRecaptchaGrid(annotated, 'image/png', {
            instruction: gridInfo.instruction || 'Select all matching images',
            rows: gridInfo.rows,
            cols: gridInfo.cols,
            mode: gridInfo.mode || 'image',
            tileCount: gridInfo.tileCount,
            annotated: true,
            provider: gridInfo.provider || 'recaptcha'
        });

        lines.push(`Selected tiles: ${matches.join(', ')}`);

        for (const tileIndex of matches) {
            const tile = gridInfo.tiles.find(entry => entry.index === tileIndex);
            if (!tile) {
                lines.push(`Warning: tile ${tileIndex} not found in DOM`);
                continue;
            }
            await this.humanClick(tile.pageX, tile.pageY);
            await sleep(220 + Math.random() * 280);
        }

        await sleep(500);
        if (gridInfo.verifyPoint) {
            await this.humanClick(gridInfo.verifyPoint.x, gridInfo.verifyPoint.y);
        } else {
            const verify = (await this.getTargets()).targets.find(target => target.action === 'click-verify');
            if (verify?.x !== undefined && verify?.y !== undefined) {
                await this.humanClick(verify.x, verify.y);
            }
        }

        await sleep(1800);
        return true;
    }

    private async solveImageGridTarget(_grid: CaptchaTarget, lines: string[]): Promise<boolean> {
        const gridInfo = await this.getGridTiles();
        if (!gridInfo.found) {
            throw new Error('Could not read grid tiles from challenge iframe');
        }
        return this.solveImageGridRound(gridInfo, lines);
    }

    private async tryAudioFallback(lines: string[]): Promise<boolean> {
        const gridInfo = await this.getGridTiles();
        const audioPoint = gridInfo.audioButtonPoint;
        if (audioPoint) {
            lines.push('Trying audio CAPTCHA fallback.');
            await this.humanClick(audioPoint.x, audioPoint.y);
            await sleep(1800);

            const refreshed = await this.getGridTiles();
            const audioUrl = (await this.getTargets()).targets.find(target => target.audioUrl)?.audioUrl;
            if (audioUrl) {
                const audioResult = await this.solveAudioFromUrl(audioUrl);
                lines.push(audioResult.output);
                return audioResult.success;
            }
        }

        const audioTarget = (await this.getTargets()).targets.find(target => target.action === 'click-audio');
        if (audioTarget?.x !== undefined && audioTarget?.y !== undefined) {
            lines.push('Trying audio CAPTCHA fallback.');
            await this.humanClick(audioTarget.x, audioTarget.y);
            await sleep(1500);

            const refreshed = await this.getTargets();
            const audioInput = refreshed.targets.find(target => target.action === 'audio-input');
            const audioUrl = audioInput?.audioUrl || refreshed.targets.find(target => target.audioUrl)?.audioUrl;
            if (audioUrl) {
                const audioResult = await this.solveAudioFromUrl(audioUrl);
                lines.push(audioResult.output);
                return audioResult.success;
            }
        }

        return false;
    }

    private async solveGenericImageCaptcha(lines: string[]): Promise<boolean> {
        const detectCode = `
            (function() {
                const captchaKeywords = /captcha|verify|challenge|security.?code|human.?check/i;
                const images = Array.from(document.querySelectorAll('img')).filter(img => {
                    const src = img.src || '';
                    const alt = img.alt || '';
                    const id = img.id || '';
                    const className = img.className || '';
                    const parentText = img.parentElement?.textContent?.slice(0, 200) || '';
                    return captchaKeywords.test(src + alt + id + className + parentText);
                }).map(img => {
                    const rect = img.getBoundingClientRect();
                    return {
                        selector: img.id ? '#' + img.id : 'img',
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                    };
                });
                const inputs = Array.from(document.querySelectorAll('input[type="text"]')).filter(input => {
                    const name = input.getAttribute('name') || '';
                    const id = input.id || '';
                    const placeholder = input.getAttribute('placeholder') || '';
                    return captchaKeywords.test(name + id + placeholder);
                }).map(input => {
                    const rect = input.getBoundingClientRect();
                    return {
                        selector: input.id ? '#' + input.id : 'input[name="' + (input.getAttribute('name') || '') + '"]',
                        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                    };
                });
                return JSON.stringify({ images, inputs });
            })()
        `;

        const result = await this.deps.sendCommand<{ value?: string }>('evaluate', {
            tabId: this.deps.tabId,
            code: detectCode
        }, 10000);

        const parsed = JSON.parse(String(result?.value ?? '{}')) as {
            images?: Array<{ selector: string; rect: Rect }>;
            inputs?: Array<{ selector: string; rect: Rect }>;
        };

        const image = parsed.images?.find(item => item.rect.width > 20 && item.rect.height > 20);
        const input = parsed.inputs?.[0];
        if (!image || !input) return false;

        lines.push(`Generic image CAPTCHA detected (${image.selector}).`);
        const screenshot = await this.deps.sendCommand<{ data: string }>('captureScreenshot', {
            tabId: this.deps.tabId,
            clip: image.rect
        }, 20000);

        const answer = await this.solver.solveImageCaptcha(screenshot.data, 'image/png');
        lines.push(`Image CAPTCHA answer: ${answer}`);

        await this.humanClick(input.rect.x + 12, input.rect.y + input.rect.height / 2);
        await this.typeText(answer);
        return true;
    }

    private async typeText(text: string): Promise<void> {
        await this.deps.sendCommand('evaluate', {
            tabId: this.deps.tabId,
            code: `
                (function() {
                    const el = document.activeElement;
                    if (!el) return false;
                    const value = ${JSON.stringify(text)};
                    if ('value' in el) {
                        el.value = value;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    }
                    return false;
                })()
            `
        }, 10000);
    }

    private async humanClick(x: number, y: number): Promise<void> {
        try {
            await this.deps.sendCommand('humanClick', {
                tabId: this.deps.tabId,
                x,
                y,
                steps: 10 + Math.floor(Math.random() * 8)
            }, 15000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!message.includes('Unknown command: humanClick')) {
                throw error;
            }
            await this.deps.sendCommand('clickCoordinates', {
                tabId: this.deps.tabId,
                x,
                y
            }, 15000);
        }
        await sleep(120);
    }

    private async isVerified(): Promise<boolean> {
        const pageStatus = await this.deps.readPageStatus();
        const frameStatus = await this.deps.readFrameStatus();
        return pageStatus.hasSolvedToken ||
            frameStatus.some(frame => frame.isChecked === true || frame.isSolved === true);
    }

    private async waitForVerification(timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
            if (await this.isVerified()) {
                await this.deps.waitForStable();
                return true;
            }
            await sleep(500);
        }
        return false;
    }

    private async formatStatus(): Promise<string> {
        const pageStatus = await this.deps.readPageStatus();
        const frameStatus = await this.deps.readFrameStatus();
        const verified = await this.isVerified();
        const lines = [`Verification status: ${verified ? 'verified' : 'pending'}`];

        if (pageStatus.responseFields.length) {
            lines.push('Response fields:');
            for (const field of pageStatus.responseFields) {
                lines.push(`- ${field.selector}: ${field.valueLength > 0 ? `token present (${field.valueLength} chars)` : 'empty'}`);
            }
        }

        if (frameStatus.length) {
            lines.push('Frame status:');
            for (const frame of frameStatus) {
                lines.push(`- ${frame.type}: checked=${String(frame.isChecked)} solved=${String(frame.isSolved)}`);
            }
        }

        return lines.join('\n');
    }
}
