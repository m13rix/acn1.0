let activeForegroundCount = 0;
let backgroundTail: Promise<void> = Promise.resolve();
let idleResolvers: Array<() => void> = [];

function flushIdleResolvers(): void {
  if (activeForegroundCount !== 0 || idleResolvers.length === 0) {
    return;
  }

  const resolvers = idleResolvers;
  idleResolvers = [];
  for (const resolve of resolvers) {
    resolve();
  }
}

function waitForForegroundIdle(): Promise<void> {
  if (activeForegroundCount === 0) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    idleResolvers.push(resolve);
  });
}

export async function runForegroundTask<T>(task: () => Promise<T>): Promise<T> {
  activeForegroundCount += 1;

  try {
    return await task();
  } finally {
    activeForegroundCount = Math.max(0, activeForegroundCount - 1);
    flushIdleResolvers();
  }
}

export async function runBackgroundTaskWhenForegroundIdle<T>(task: () => Promise<T>): Promise<T> {
  const previousTail = backgroundTail;
  let release: (() => void) | undefined;
  const completionGate = new Promise<void>(resolve => {
    release = resolve;
  });

  backgroundTail = previousTail.catch(() => undefined).then(() => completionGate);

  await previousTail.catch(() => undefined);
  await waitForForegroundIdle();

  try {
    return await task();
  } finally {
    release?.();
  }
}

export function getExecutionGateSnapshot(): { activeForegroundCount: number } {
  return { activeForegroundCount };
}

export function resetExecutionGateForTests(): void {
  activeForegroundCount = 0;
  backgroundTail = Promise.resolve();
  idleResolvers = [];
}
