import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function withRefreshLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const lockFile = `${lockPath}.lock`;

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
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
}
