
import { AsyncLocalStorage } from 'async_hooks';

export interface ActionContextState {
    chatId?: string;
    telegramService?: any; // Avoiding circular dependency for now, or use interface
    sessionId?: string;
    env?: Record<string, string>;
}

export const actionContext = new AsyncLocalStorage<ActionContextState>();
