import { structuredLlm } from '../../../../src/utils/structuredLlm.js';
import type { HeartbeatSensorEvent, SensorAskInput } from '../../../../src/heartbeat/types.js';

const SECOND_MS = 1000;
const MAX_CATCH_UP_SECONDS = 60;

let timerId: NodeJS.Timeout | null = null;
let emitFn: ((event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) | null = null;
let lastProcessedSecondMs: number | null = null;

function buildPayload(now: Date) {
  return {
    iso: now.toISOString(),
    localeTime: now.toLocaleTimeString(),
    localeDate: now.toLocaleDateString(),
    weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
    hour: now.getHours(),
    minute: now.getMinutes(),
    second: now.getSeconds(),
    timestamp: now.getTime(),
  };
}

export async function start(emit: (event: Omit<HeartbeatSensorEvent, 'sensor'>) => void) {
  emitFn = emit;
  lastProcessedSecondMs = null;
  scheduleNextTick();
}

export async function stop() {
  if (timerId) {
    clearTimeout(timerId);
  }
  timerId = null;
  emitFn = null;
  lastProcessedSecondMs = null;
}

export async function getContext(): Promise<string> {
  const now = new Date();
  const payload = buildPayload(now);
  return [
    `ISO: ${payload.iso}`,
    `Local time: ${payload.localeTime}`,
    `Local date: ${payload.localeDate}`,
    `Weekday: ${payload.weekday}`,
  ].join('\n');
}

export async function ask(input: SensorAskInput): Promise<unknown> {
  const context = await getContext();
  return structuredLlm([
    'You are answering questions about the internal clock sensor state.',
    '',
    'Clock context:',
    context,
    '',
    'User request:',
    input.prompt,
  ].join('\n'), input.schema, input.imagePath);
}

function emitEvery(interval: string, now: Date): void {
  if (!emitFn) {
    return;
  }

  emitFn({
    event: 'every',
    args: [interval],
    payload: buildPayload(now),
    occurredAt: now.toISOString(),
  });
}

function emitSchedule(now: Date): void {
  if (!emitFn) {
    return;
  }

  emitFn({
    event: 'schedule',
    args: [],
    payload: buildPayload(now),
    occurredAt: now.toISOString(),
  });
}

function emitAt(now: Date): void {
  if (!emitFn) {
    return;
  }

  emitFn({
    event: 'at',
    args: [`${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`],
    payload: buildPayload(now),
    occurredAt: now.toISOString(),
  });
}

function emitEventsForSecond(now: Date): void {
  const seconds = now.getSeconds();
  const minutes = now.getMinutes();

  emitEvery('1s', now);
  if (seconds % 5 === 0) emitEvery('5s', now);
  if (seconds % 10 === 0) emitEvery('10s', now);
  if (seconds === 0) emitEvery('1m', now);
  if (seconds === 0 && minutes % 5 === 0) emitEvery('5m', now);
  if (seconds === 0 && minutes % 10 === 0) emitEvery('10m', now);
  if (seconds === 0 && minutes === 0) emitEvery('1h', now);

  if (seconds === 0) {
    emitSchedule(now);
    emitAt(now);
  }
}

export function collectClockEventsUpTo(
  now: Date,
  previousSecondMs: number | null,
  options: { maxCatchUpSeconds?: number } = {}
): { processedSecondMs: number; replayedSeconds: number[]; truncatedCatchUp: boolean } {
  const processedSecondMs = Math.floor(now.getTime() / SECOND_MS) * SECOND_MS;
  const maxCatchUpSeconds = options.maxCatchUpSeconds ?? MAX_CATCH_UP_SECONDS;

  if (previousSecondMs === null) {
    return {
      processedSecondMs,
      replayedSeconds: [processedSecondMs],
      truncatedCatchUp: false,
    };
  }

  const elapsedSeconds = Math.floor((processedSecondMs - previousSecondMs) / SECOND_MS);
  if (elapsedSeconds <= 0) {
    return {
      processedSecondMs: previousSecondMs,
      replayedSeconds: [],
      truncatedCatchUp: false,
    };
  }

  const truncatedCatchUp = elapsedSeconds > maxCatchUpSeconds;
  const catchUpStartSecondMs = truncatedCatchUp
    ? processedSecondMs
    : previousSecondMs + SECOND_MS;

  const replayedSeconds: number[] = [];
  for (let secondMs = catchUpStartSecondMs; secondMs <= processedSecondMs; secondMs += SECOND_MS) {
    replayedSeconds.push(secondMs);
  }

  return {
    processedSecondMs,
    replayedSeconds,
    truncatedCatchUp,
  };
}

function processTick(now: Date): void {
  if (!emitFn) {
    return;
  }

  const result = collectClockEventsUpTo(now, lastProcessedSecondMs);
  if (result.truncatedCatchUp && lastProcessedSecondMs !== null) {
    console.warn(
      `[Clock Sensor] Skipped ${(result.processedSecondMs - lastProcessedSecondMs) / SECOND_MS}s of backlog; replaying only the current second.`
    );
  }
  for (const secondMs of result.replayedSeconds) {
    emitEventsForSecond(new Date(secondMs));
  }

  lastProcessedSecondMs = result.processedSecondMs;
}

function scheduleNextTick(): void {
  if (!emitFn) {
    return;
  }

  const delay = Math.max(1, SECOND_MS - (Date.now() % SECOND_MS));
  timerId = setTimeout(tick, delay);
}

function tick() {
  processTick(new Date());
  scheduleNextTick();
}
