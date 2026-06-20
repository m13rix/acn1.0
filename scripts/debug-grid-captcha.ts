/**
 * Debug image-grid CAPTCHA: saves screenshot + tile coords + Gemini analysis.
 */
import 'dotenv/config';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { BrowserSandbox } from '../src/sandbox/BrowserSandbox.js';
import { CaptchaSolver } from '../src/sandbox/CaptchaSolver.js';

const OUT = join(process.cwd(), 'sandboxes', 'captcha-debug');

async function main() {
    await mkdir(OUT, { recursive: true });
    const sandbox = new BrowserSandbox() as any;
    await sandbox.initialize([], undefined);

    const url = process.argv[2] || 'https://www.last.fm/join';
    await sandbox.executeCli(`goto ${url}`);
    await sandbox.executeCli('captcha solve');

    // Re-trigger if only checkbox was clicked - run partial solve to get grid
    const sendCommand = (cmd: string, params: object) => sandbox['sendCommand'](cmd, params);
    const tabId = sandbox['activeTabId'];

    const targets = await sendCommand('getCaptchaTargets', { tabId });
    console.log('Targets:', JSON.stringify(targets, null, 2));

    const grid = targets.targets?.find((t: any) => t.action === 'grid');
    if (!grid) {
        console.log('No grid target - trying captcha solve again');
        await sandbox.executeCli('captcha solve');
    }

    const tileInfo = await sendCommand('getGridTiles', { tabId });
    console.log('Grid tiles from DOM:', JSON.stringify(tileInfo, null, 2));

    const grid2 = (await sendCommand('getCaptchaTargets', { tabId })).targets?.find((t: any) => t.action === 'grid');
    const rect = grid2?.gridRect || { x: 0, y: 0, width: 400, height: 400 };

    const screenshot = await sendCommand('captureScreenshot', {
        tabId,
        clip: {
            x: Math.max(0, rect.x - 8),
            y: Math.max(0, rect.y - 80),
            width: rect.width + 16,
            height: rect.height + 120
        }
    });

    const pngPath = join(OUT, 'grid-screenshot.png');
    await writeFile(pngPath, Buffer.from(screenshot.data, 'base64'));
    console.log('Saved screenshot:', pngPath);

    const solver = CaptchaSolver.getInstance();
    const analysis = await solver.solveGridCaptchaAuto(screenshot.data, 'image/png');
    console.log('Gemini analysis:', analysis);

    if (tileInfo?.tiles?.length) {
        console.log('\nTile click points (from DOM):');
        for (const idx of analysis.matches) {
            const tile = tileInfo.tiles[idx - 1];
            if (tile) {
                console.log(`  Tile ${idx}: page (${tile.pageX}, ${tile.pageY}) frame-local (${tile.x}, ${tile.y})`);
            }
        }
    }

    await sandbox.cleanup();
}

main().catch(console.error);
