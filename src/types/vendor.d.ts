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

declare module 'localtunnel' {
  import { EventEmitter } from 'events';

  export interface LocalTunnelOptions {
    port: number;
    host?: string;
    subdomain?: string;
    local_host?: string;
    local_https?: boolean;
    local_cert?: string;
    local_key?: string;
    local_ca?: string;
    allow_invalid_cert?: boolean;
  }

  export interface LocalTunnel extends EventEmitter {
    url: string;
    cachedUrl?: string;
    close(): void;
  }

  export type LocalTunnelCallback = (error?: Error | null, tunnel?: LocalTunnel) => void;

  export default function localtunnel(options: LocalTunnelOptions): Promise<LocalTunnel>;
  export default function localtunnel(options: LocalTunnelOptions, callback: LocalTunnelCallback): LocalTunnel;
}
