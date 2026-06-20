/**
 * Quick manual test for CAPTCHA automation.
 * Usage: npx tsx scripts/test-captcha-solve.ts [url]
 *
 * Requires Telos Browser Control extension connected and GEMINI_KEY in .env for image/audio challenges.
 */
import 'dotenv/config';
import { BrowserSandbox } from '../src/sandbox/BrowserSandbox.js';

const url = process.argv[2] || 'https://www.google.com/recaptcha/api2/demo';

async function main() {
    const sandbox = new BrowserSandbox();
    console.log(`Starting browser sandbox session...`);
    await sandbox.initialize([], undefined);

    console.log(`Navigating to ${url}`);
    const nav = await sandbox.executeCli(`goto ${url}`);
    console.log(nav.output || nav.error);

    console.log('\n--- captcha detect ---');
    const detect = await sandbox.executeCli('captcha detect');
    console.log(detect.output || detect.error);

    console.log('\n--- captcha solve ---');
    const solve = await sandbox.executeCli('captcha solve');
    console.log(solve.output || '');
    if (solve.error) console.error(solve.error);

    console.log('\n--- captcha detect (after) ---');
    const detectAfter = await sandbox.executeCli('captcha detect');
    console.log(detectAfter.output || detectAfter.error);

    await sandbox.cleanup();
    process.exit(solve.success ? 0 : 1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
