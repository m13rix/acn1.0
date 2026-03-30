import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TokenRefreshLockTimeoutError } from '../errors.js';

export async function withRefreshLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lockFile = `${lockPath}.lock`;
  const startedAt = Date.now();
  const staleAfterMs = 60_000;
  const maxWaitMs = 15_000;

  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      try {
        return await fn();
      } finally {
        await handle.close();
        await fs.unlink(lockFile).catch(() => {});
      }
    } catch {
      const ageMs = await getLockAgeMs(lockFile);
      if (ageMs !== undefined && ageMs > staleAfterMs) {
        await fs.unlink(lockFile).catch(() => {});
        continue;
      }

      if (Date.now() - startedAt > maxWaitMs) {
        throw new TokenRefreshLockTimeoutError();
      }

      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}

async function getLockAgeMs(lockFile: string): Promise<number | undefined> {
  try {
    const stat = await fs.stat(lockFile);
    return Date.now() - stat.mtimeMs;
  } catch {
    return undefined;
  }
}
