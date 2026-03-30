import type { VoiceProvider, VoiceSession, VoiceSessionConfig } from '../../types/index.js';

export abstract class BaseVoiceProvider implements VoiceProvider {
  abstract name: string;

  abstract connect(config: VoiceSessionConfig): Promise<VoiceSession>;

  buildConnectRequest(_config: VoiceSessionConfig): any {
    return undefined;
  }

  protected validateConfig(config: VoiceSessionConfig): void {
    if (!config.model) {
      throw new Error('Voice provider config requires a model.');
    }
  }
}
