/**
 * Clock Sensor
 * 
 * Provides time-based triggers and context.
 */

let intervalId: NodeJS.Timeout | null = null;
let emitFn: ((event: string, payload?: any) => void) | null = null;

export const events = {
    every: (interval: string) => `events.every(${interval})`,
    at: (time: string) => `events.at(${time})`,
    after: (delay: string) => `events.after(${delay})`
};

export async function start(emit: (event: string, payload?: any) => void) {
    console.log('[Clock] Sensor started.');
    emitFn = emit;
    intervalId = setInterval(tick, 1000);
}

export async function stop() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
    emitFn = null;
}

export async function getContext(): Promise<string> {
    const now = new Date();
    return `
Time: ${now.toLocaleTimeString()}
Date: ${now.toLocaleDateString()}
Weekday: ${now.toLocaleDateString('en-US', { weekday: 'long' })}
    `.trim();
}

export async function ask(query: string): Promise<string> {
    const ctx = await getContext();
    return `Based on my internal clock: ${ctx}\n(Query: "${query}")`;
}

function tick() {
    if (!emitFn) return;
    const now = new Date();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours();

    // 1. Every (Basic intervals)
    emitFn(`events.every(1s)`);
    if (seconds % 5 === 0) emitFn(`events.every(5s)`);
    if (seconds % 10 === 0) emitFn(`events.every(10s)`);
    if (seconds === 0) emitFn(`events.every(1m)`);
    if (seconds === 0 && minutes % 5 === 0) emitFn(`events.every(5m)`);
    if (seconds === 0 && minutes % 10 === 0) emitFn(`events.every(10m)`);
    if (seconds === 0 && minutes === 0) emitFn(`events.every(1h)`);

    // 2. At (Daily Schedule)
    if (seconds === 0) {
        const hh = hours.toString().padStart(2, '0');
        const mm = minutes.toString().padStart(2, '0');
        // Emit trigger: "events.at(14:30)"
        emitFn(`events.at(${hh}:${mm})`);
    }
}
