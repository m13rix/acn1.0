export const PRIMARY_COMPLETION_FUNCTION = 'TASK_DONE';
export const LEGACY_COMPLETION_FUNCTION = 'FINISH';

export const COMPLETION_SIGNAL_START = '__ACN_TASK_DONE_START__';
export const COMPLETION_SIGNAL_END = '__ACN_TASK_DONE_END__';

export const COMPLETION_SIGNAL_REGEX =
  /__(?:ACN_TASK_DONE_START|ACN_FINISH_START)__(.*?)__(?:ACN_TASK_DONE_END|ACN_FINISH_END)__/s;

const PLAIN_COMPLETION_REGEXES = [
  /\b(?:TASK_DONE|FINISH)\s*\(\s*"([\s\S]*?)"\s*\)/s,
  /\b(?:TASK_DONE|FINISH)\s*\(\s*'([\s\S]*?)'\s*\)/s,
  /\b(?:TASK_DONE|FINISH)\s*\(\s*`([\s\S]*?)`\s*\)/s,
];

export const COMPLETION_TOOL_NAMES = new Set([
  PRIMARY_COMPLETION_FUNCTION.toLowerCase(),
  LEGACY_COMPLETION_FUNCTION.toLowerCase(),
  'taskdone',
  'task_done',
]);

export function isCompletionToolName(name: unknown): boolean {
  return COMPLETION_TOOL_NAMES.has(String(name ?? '').trim().toLowerCase());
}

export function buildCompletionWarning(): string {
  return `SYSTEM: Keep working until the task is truly complete. If you need clarification from the user, ask via \`message.ask(...)\` inside \`action(...)\`. Call \`${PRIMARY_COMPLETION_FUNCTION}("final user-facing message")\` only when you are fully done and ready to send the final result to the user.`;
}

export function buildCompletionContinuationMessage(): string {
  return `Continue working with tools. If you need user input, use \`message.ask(...)\` inside \`action(...)\`. Call \`${PRIMARY_COMPLETION_FUNCTION}("final user-facing message")\` only when everything is actually complete.`;
}

export function extractCompletionMessage(text: unknown): string | null {
  const source = String(text ?? '');
  if (!source.trim()) {
    return null;
  }

  const signaled = source.match(COMPLETION_SIGNAL_REGEX);
  if (signaled) {
    const rawPayload = signaled[1];
    if (!rawPayload) {
      return null;
    }
    try {
      const parsed = JSON.parse(rawPayload);
      return typeof parsed === 'string' ? parsed : String(parsed);
    } catch {
      return null;
    }
  }

  for (const regex of PLAIN_COMPLETION_REGEXES) {
    const match = source.match(regex);
    const payload = match?.[1];
    if (typeof payload === 'string') {
      return payload;
    }
  }

  return null;
}
