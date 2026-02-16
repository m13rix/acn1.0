// Type declarations for modules without types

declare module 'sharp' {
    interface Sharp {
        metadata(): Promise<{ width?: number; height?: number; format?: string }>;
        resize(width: number, height: number, options?: { fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside' }): Sharp;
        blur(sigma: number): Sharp;
        toBuffer(): Promise<Buffer>;
        composite(images: Array<{ input: Buffer; left: number; top: number }>): Sharp;
        toFile(path: string): Promise<void>;
    }

    function sharp(input: string | Buffer): Sharp;
    export = sharp;
}

declare module 'wav' {
    export class FileWriter {
        constructor(path: string, options: { channels: number; sampleRate: number; bitDepth: number });
        on(event: 'finish' | 'error', callback: (err?: Error) => void): void;
        write(data: Buffer): void;
        end(): void;
    }
}
