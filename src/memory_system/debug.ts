export interface MemoryDebugEvent {
  atMs: number;
  scope: string;
  message: string;
  data?: unknown;
}

export interface MemoryDebugTrace {
  operation: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  success?: boolean;
  events: MemoryDebugEvent[];
}

export type MemoryDebugLogger = (scope: string, message: string, data?: unknown) => void;

type TraceUpdateListener = (trace: MemoryDebugTrace, event?: MemoryDebugEvent) => void;

interface TraceWithListener extends MemoryDebugTrace {
  __listener__?: TraceUpdateListener;
}

export function appendMemoryDebugEvent(
  trace: MemoryDebugTrace,
  scope: string,
  message: string,
  data?: unknown,
): MemoryDebugEvent {
  const extended = trace as TraceWithListener;
  const event: MemoryDebugEvent = {
    atMs: Date.now() - new Date(trace.startedAt).getTime(),
    scope,
    message,
    ...(data === undefined ? {} : { data }),
  };
  trace.events.push(event);
  extended.__listener__?.(trace, event);
  return event;
}

export function createMemoryDebugTrace(
  operation: string,
  onUpdate?: TraceUpdateListener,
): { trace: MemoryDebugTrace; log: MemoryDebugLogger } {
  const started = Date.now();
  const trace: TraceWithListener = {
    operation,
    startedAt: new Date(started).toISOString(),
    events: [],
  };
  trace.__listener__ = onUpdate;

  const log: MemoryDebugLogger = (scope, message, data) => {
    appendMemoryDebugEvent(trace, scope, message, data);
  };

  return { trace, log };
}

export function finalizeMemoryDebugTrace(trace: MemoryDebugTrace, success: boolean): MemoryDebugTrace {
  const extended = trace as TraceWithListener;
  const finished = Date.now();
  trace.finishedAt = new Date(finished).toISOString();
  trace.durationMs = new Date(trace.finishedAt).getTime() - new Date(trace.startedAt).getTime();
  trace.success = success;
  extended.__listener__?.(trace);
  return trace;
}

export function summarizeText(value: string, maxLength = 1200): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength)}... [truncated ${normalized.length - maxLength} chars]`;
}
