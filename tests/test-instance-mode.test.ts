import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve();
      return;
    }

    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
      return;
    }

    child.kill('SIGTERM');
    child.once('close', () => resolve());
  });
}

test('chat --test-instance starts isolated API-only runtime', async () => {
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const child = spawn(process.execPath, [tsxCliPath, 'src/cli/chat.ts', '--test-instance'], {
    cwd: process.cwd(),
    env: { ...process.env, TELOS_TEST_INSTANCE: '1' },
    shell: false,
    windowsHide: true,
  });

  let combined = '';

  try {
    const ready = await new Promise<{ apiUrl: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for test-instance readiness.\n${combined}`));
      }, 30000);

      const handleChunk = (chunk: string) => {
        combined += chunk;
        const match = combined.match(/TELOS_TEST_INSTANCE_READY (\{.*\})/);
        if (!match) {
          return;
        }

        clearTimeout(timeout);
        resolve(JSON.parse(match[1]!) as { apiUrl: string });
      };

      child.stdout.on('data', (chunk) => handleChunk(chunk.toString()));
      child.stderr.on('data', (chunk) => handleChunk(chunk.toString()));
      child.once('error', reject);
      child.once('close', (code) => {
        reject(new Error(`Test instance exited before readiness with code ${code}.\n${combined}`));
      });
    });

    assert.match(ready.apiUrl, /^http:\/\/localhost:\d+$/);

    const response = await fetch(`${ready.apiUrl}/api/health`);
    assert.equal(response.ok, true);
    const body = await response.json() as { success?: boolean };
    assert.equal(body.success, true);
  } finally {
    await killChild(child);
  }
});
