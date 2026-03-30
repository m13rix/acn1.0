import type { AgentInterfaceRuntime, InterfaceRuntimeContext } from './base.js';

export class TelegramInterfaceRuntime implements AgentInterfaceRuntime {
  name = 'telegram';

  supportsModality(modality: 'text' | 'voice'): boolean {
    return modality === 'text';
  }

  async start(_context: InterfaceRuntimeContext): Promise<void> {
    // Telegram sessions are created lazily inside TelegramService.
  }
}
