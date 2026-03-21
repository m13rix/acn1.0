export interface QueuedCallResult<T> {
  waited: boolean;
  value: T;
}

const sandboxQueueTails = new Map<string, Promise<void>>();
const sandboxQueuePending = new Map<string, number>();

function normalizeQueueKey(rawKey: string): string {
  const key = String(rawKey || '').trim();
  return key || '__default_sandbox__';
}

export async function runInSandboxCallQueue<T>(
  sandboxKey: string,
  task: () => Promise<T>
): Promise<QueuedCallResult<T>> {
  const key = normalizeQueueKey(sandboxKey);
  const pending = sandboxQueuePending.get(key) ?? 0;
  const waited = pending > 0;
  sandboxQueuePending.set(key, pending + 1);

  const previousTail = sandboxQueueTails.get(key) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const completionGate = new Promise<void>(resolve => {
    release = () => resolve();
  });
  const nextTail = previousTail.catch(() => undefined).then(() => completionGate);
  sandboxQueueTails.set(key, nextTail);

  await previousTail.catch(() => undefined);

  try {
    const value = await task();
    return { waited, value };
  } finally {
    if (release) {
      release();
    }
    const nextPending = (sandboxQueuePending.get(key) ?? 1) - 1;
    if (nextPending <= 0) {
      sandboxQueuePending.delete(key);
      sandboxQueueTails.delete(key);
    } else {
      sandboxQueuePending.set(key, nextPending);
    }
  }
}

export function resetSandboxCallQueueForTests(): void {
  sandboxQueueTails.clear();
  sandboxQueuePending.clear();
}
