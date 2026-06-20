const REQUEST_OBJECT_KEYS = ['instruction', 'request', 'message', 'prompt', 'content'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeAgentRequest(input: unknown, methodName: 'call' | 'callSelf' | 'resume' | 'run' | 'start' | 'send'): string {
  if (typeof input === 'string') {
    return input;
  }

  if (isPlainObject(input)) {
    for (const key of REQUEST_OBJECT_KEYS) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }

  const error = `Error: agents.${methodName}(request) expects a string or an object with one of: ${REQUEST_OBJECT_KEYS.join(', ')}.`;
  console.warn(`[agents] ${error}`, { receivedType: typeof input });
  return error;
}
