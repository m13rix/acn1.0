declare module 'node-global-key-listener' {
  export class GlobalKeyboardListener {
    addListener(listener: (event: { state: string; name: string; ctrlKey?: boolean }) => void): void;
    removeAllListeners(): void;
    kill(): void;
  }
}

declare module 'speaker' {
  export default class Speaker {
    constructor(options?: Record<string, unknown>);
    write(chunk: Buffer): boolean;
    end(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
}
