/**
 * Heartbeat Tool
 * 
 * Allows agents to interact with the ACN Heartbeat System.
 * - Create, List, Manage Tasks
 * - Explore and Use Sensors
 */

import { HeartbeatService } from '../../src/heartbeat/HeartbeatService.js';
import { sendRequest } from '../srcAgent/index.js';

const service = HeartbeatService.getInstance();

// Auto-initialize when tool is loaded in sandbox
let initPromise: Promise<void> | null = null;

async function ensureInitialized() {
    if (initPromise) return initPromise;
    // console.log("[Heartbeat Tool] Starting initialization...");
    initPromise = service.initialize({ enableWatcher: false })
        // .then(() => console.log("[Heartbeat Tool] Initialization complete."))
        .catch(e => {
            console.error("[Heartbeat Tool] Init failed:", e);
            initPromise = null; // Retry on next call?
            throw e;
        });
    return initPromise;
}

// Start immediately but don't await
ensureInitialized();

export const tasks = {
    /**
     * Create a new heartbeat task.
     * 
     * @param name - Unique name/ID for the task.
     * @param options - Task configuration.
     * @param options.trigger - The event signature (e.g. "clock.events.every(10m)")
     * @param options.condition - Optional logic prompt (e.g. "Is it urgent?")
     * @param options.action - The prompt for the agent to execute when triggered.
     * @param options.maxRepeats - Optional. Number of times to run. -1 for infinite.
     */
    create: async (name: string, options: {
        trigger: string;
        condition?: string;
        action: string;
        maxRepeats?: number;
    }) => {
        return service.createTask(name, options);
    },

    /**
     * List all tasks (active and inactive).
     */
    list: async () => {
        return service.listTasks();
    },

    /**
     * Edit an existing task.
     */
    edit: async (name: string, options: {
        trigger?: string;
        condition?: string;
        action?: string;
        maxRepeats?: number;
    }) => {
        return service.editTask(name, options);
    },

    /**
     * Toggle a task's active state.
     */
    setActive: async (name: string, active: boolean) => {
        return service.setActive(name, active);
    },

    /**
     * Delete a task permanently.
     */
    delete: async (name: string) => {
        return service.deleteTask(name);
    }
};

export const sensors = {
    /**
     * List available sensors and their documentation.
     */
    list: async () => {
        await ensureInitialized();
        const docs = service.getSensorDocs();
        if (!docs) return "No sensors loaded.";
        return docs;
    },

    /**
     * Ask a specific sensor a question using its internal logic/data.
     */
    ask: async (name: string, query: string) => {
        return service.askSensor(name, query);
    },

    /**
     * Create a new sensor using srcAgent (Gemini CLI).
     * @param prompt - Description of the sensor to build.
     */
    create: async (prompt: string) => {
        const geminiPrompt = `
You act as an expert developer creating a new ACN Sensor module.
User Request: ${prompt}

Standard Sensor Structure:
tools/heartbeat/sensors/[name]/
  - index.ts (Logic)
  - sensor.yaml (Config)

API Requirements for index.ts:
- export async function start(emit: (event: string, payload?: any) => void)
- export async function stop()
- export async function getContext(): Promise<string>
- export async function ask(query: string): Promise<string> (Optional but recommended)
- export const events = { ... } (Helper factories for triggers)

Config Requirements for sensor.yaml:
name: [name]
description: [docs]
minillm:
  model: openai/gpt-oss-20b
  provider: openrouter

Please generate the necessary files and code to implement this sensor.
        `.trim();

        return await sendRequest(geminiPrompt);
    }
};
