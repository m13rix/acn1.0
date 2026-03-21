export const PRIMARY_COMPLETION_FUNCTION = 'TASK_DONE';
export const LEGACY_COMPLETION_FUNCTION = 'FINISH';

export const COMPLETION_SIGNAL_START = '__ACN_TASK_DONE_START__';
export const COMPLETION_SIGNAL_END = '__ACN_TASK_DONE_END__';

export const COMPLETION_SIGNAL_REGEX =
  /__(?:ACN_TASK_DONE_START|ACN_FINISH_START)__(.*?)__(?:ACN_TASK_DONE_END|ACN_FINISH_END)__/s;

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
