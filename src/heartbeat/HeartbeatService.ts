/**
 * Heartbeat Service
 *
 * The central orchestrator for the ACN Heartbeat System.
 * - Manages Tasks (CRUD, Persistence)
 * - Manages Sensors (Loading, Lifecycle)
 * - Handles Events -> Pulse Logic -> Action Execution
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import * as yaml from 'js-yaml';

import { HeartbeatTask, Sensor, SensorConfig } from './types.js';
import { Pulse } from './Pulse.js';
import { LocalSandbox } from '../sandbox/LocalSandbox.js';
import { runAgent } from '../core/AgentRunner.js';
import { getAgentSandbox, getParentAgentName } from '../core/AgentContext.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { AgentLoader } from '../loaders/AgentLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT_DIR, 'data', 'heartbeat');
const TOOLS_DIR = path.join(ROOT_DIR, 'tools', 'heartbeat', 'sensors');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

export class HeartbeatService extends EventEmitter {
    private static instance: HeartbeatService;

    private tasks: Map<string, HeartbeatTask> = new Map();
    private sensors: Map<string, Sensor> = new Map();
    private sensorConfigs: Map<string, SensorConfig> = new Map();

    // Loaders
    private toolLoader = new ToolLoader();
    private agentLoader = new AgentLoader();

    private initialized = false;

    private constructor() {
        super();
        this.ensureDataDir();
    }

    public static getInstance(): HeartbeatService {
        if (!HeartbeatService.instance) {
            HeartbeatService.instance = new HeartbeatService();
        }
        return HeartbeatService.instance;
    }

    private ensureDataDir() {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
    }

    private initializing = false;

    public async initialize(options: { enableWatcher?: boolean } = {}) {
        if (this.initialized || this.initializing) return;
        this.initializing = true;

        // 1. Load Tasks
        this.loadTasks();

        if (options.enableWatcher !== false) {
            this.watchTasks();
        } else {
            // console.log('[Heartbeat] Task watching disabled (Tool Mode).');
        }

        // 2. Discover and Load Sensors (Configs & Modules only)
        await this.loadSensors();

        this.initialized = true;
    }

    public async start() {
        console.log('[Heartbeat] Starting Active Service...');
        // Start all sensors
        for (const [name, sensor] of this.sensors) {
            console.log(`[Heartbeat] Starting sensor: ${name}`);
            try {
                await sensor.start((event: string, payload?: any) => {
                    this.handleEvent(name, event, payload);
                });
            } catch (e) {
                console.error(`[Heartbeat] Failed to start sensor '${name}':`, e);
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Task Management
    // ────────────────────────────────────────────────────────────────────────

    private loadTasks() {
        if (fs.existsSync(TASKS_FILE)) {
            try {
                const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
                if (Array.isArray(data)) {
                    // Clear existing to avoid stale data (optional, but safer if we want exact sync)
                    // actually, we might want to keep running tasks active? 
                    // No, for now let's just update definitions.
                    data.forEach(t => {
                        // If task exists, we update it. If it doesn't, we add it.
                        // If a task was deleted in file, we should arguably delete it here too.
                        // For a full sync, we should probably re-create the map or mark missing ones.
                        // Let's do a merge for now to be safe with active handlers.

                        const existing = this.tasks.get(t.name);
                        if (existing) {
                            // Update properties but maybe keep runtime state? 
                            // Actually, runtime state like 'remainingRepeats' IS persisted.
                            // So we can just overwrite.
                            Object.assign(existing, t);
                        } else {
                            this.tasks.set(t.name, t);
                        }
                    });
                }
            } catch (e) {
                console.error('[Heartbeat] Failed to load tasks:', e);
            }
        }
    }

    private watchTasks() {
        if (!fs.existsSync(DATA_DIR)) return;

        let fsWait: NodeJS.Timeout | false = false;

        try {
            fs.watch(TASKS_FILE, (eventType, filename) => {
                if (filename && eventType === 'change') {
                    if (fsWait) return;
                    fsWait = setTimeout(() => {
                        fsWait = false;
                        this.loadTasks();
                    }, 100); // Debounce
                }
            });
        } catch (e) {
            console.warn('[Heartbeat] Failed to set up file watcher for tasks:', e);
        }
    }

    private saveTasks() {
        try {
            const arr = Array.from(this.tasks.values());
            fs.writeFileSync(TASKS_FILE, JSON.stringify(arr, null, 2), 'utf-8');
        } catch (e) {
            console.error('[Heartbeat] Failed to save tasks:', e);
        }
    }

    public createTask(name: string, options: {
        trigger: string;
        condition?: string;
        action: string;
        maxRepeats?: number;
    }): string {
        if (this.tasks.has(name)) {
            throw new Error(`Task '${name}' already exists.`);
        }

        // Capture Context
        const agentName = getParentAgentName() || 'CORE'; // Fallback to CORE if system created
        let toolNames: string[] = ['heartbeat', 'files', 'message']; // Defaults

        const sandbox = getAgentSandbox();
        if (sandbox instanceof LocalSandbox) {
            toolNames = sandbox.getTools().map(t => t.config.name);
        }

        const task: HeartbeatTask = {
            id: name, // Using name as unique ID
            name: name,
            trigger: options.trigger,
            condition: options.condition,
            action: options.action,
            active: true,
            maxRepeats: options.maxRepeats ?? -1,
            remainingRepeats: options.maxRepeats ?? -1,
            agentName,
            tools: toolNames
        };

        this.tasks.set(name, task);
        this.saveTasks();

        // Check if we need to wire up this task immediately (if sensor is running)
        // Actually, logic is Event Driven: Listener is dynamic or global.
        // We will just update our lookup.

        return `Task '${name}' created successfully.`;
    }

    public listTasks(): string {
        const currentAgent = getParentAgentName();

        const active: string[] = [];
        const inactive: string[] = [];

        this.tasks.forEach(t => {
            // Filter: Only show tasks for current agent (or if current is system/undefined, show all?)
            // Let's be strict: only show own tasks.
            if (currentAgent && t.agentName !== currentAgent) return;

            if (t.active) {
                const cond = t.condition ? ` -> condition: "${t.condition.slice(0, 30)}..."` : '';
                const repeats = (t.maxRepeats && t.maxRepeats > 0) ? ` [${t.remainingRepeats} left]` : '';
                active.push(`- **${t.name}**: ${t.trigger}${cond}${repeats}`);
            } else {
                inactive.push(`- **${t.name}**: Deactivated`);
            }
        });

        if (active.length === 0 && inactive.length === 0) return "No tasks registered.";

        return `Active Tasks:\n${active.join('\n')}\n\nInactive Tasks:\n${inactive.join('\n')}`;
    }

    public editTask(name: string, options: Partial<HeartbeatTask>): string {
        const task = this.tasks.get(name);
        if (!task) throw new Error(`Task '${name}' not found.`);

        Object.assign(task, options);
        this.saveTasks();
        return `Task '${name}' updated.`;
    }

    public setActive(name: string, state: boolean): string {
        const task = this.tasks.get(name);
        if (!task) throw new Error(`Task '${name}' not found.`);

        task.active = state;
        this.saveTasks();
        return `Task '${name}' is now ${state ? 'ACTIVE' : 'INACTIVE'}.`;
    }

    public deleteTask(name: string): string {
        if (!this.tasks.delete(name)) throw new Error(`Task '${name}' not found.`);
        this.saveTasks();
        return `Task '${name}' deleted.`;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Sensor Management
    // ────────────────────────────────────────────────────────────────────────

    private async loadSensors() {
        if (!fs.existsSync(TOOLS_DIR)) {
            console.warn(`[Heartbeat] Tools directory not found: ${TOOLS_DIR}`);
            return;
        }

        const entries = fs.readdirSync(TOOLS_DIR, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const sensorName = entry.name;
                const sensorPath = path.join(TOOLS_DIR, sensorName);
                const configPath = path.join(sensorPath, 'sensor.yaml');
                const modulePath = path.join(sensorPath, 'index.ts');

                // console.log(`[Heartbeat] Found sensor directory: ${sensorName}`);

                // 1. Load Config
                if (fs.existsSync(configPath)) {
                    try {
                        const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as SensorConfig;
                        this.sensorConfigs.set(sensorName, config);
                    } catch (e) {
                        console.error(`[Heartbeat] Invalid config for sensor '${sensorName}':`, e);
                        continue;
                    }
                } else {
                    console.warn(`[Heartbeat] No sensor.yaml for '${sensorName}'`);
                }

                // 2. Load Module
                if (fs.existsSync(modulePath)) {
                    try {
                        // Dynamic import
                        // Use file:// URL for Windows compatibility
                        const moduleUrl = `file://${modulePath.replace(/\\/g, '/')}`;
                        const module = await import(moduleUrl);

                        // Expect 'start', 'stop', 'getContext', 'events'
                        const sensor = {
                            start: module.start,
                            stop: module.stop,
                            getContext: module.getContext,
                            ask: module.ask,
                            onTaskExecuted: module.onTaskExecuted
                        } as Sensor;

                        this.sensors.set(sensorName, sensor);

                        // NOTE: Sensor start moved to start() method.

                    } catch (e) {
                        console.error(`[Heartbeat] Failed to load sensor module '${sensorName}':`, e);
                    }
                } else {
                    console.warn(`[Heartbeat] No index.ts in '${sensorName}'`);
                }
            }
        }
    }

    public getSensorDocs(): string {
        const docs: string[] = [];
        this.sensorConfigs.forEach(conf => {
            docs.push(`### ${conf.name}\n${conf.description}\n`);
        });
        return docs.join('\n');
    }

    public async askSensor(name: string, query: string): Promise<string> {
        const sensor = this.sensors.get(name);
        if (!sensor) throw new Error(`Sensor '${name}' not found or not loaded.`);
        if (!sensor.ask) throw new Error(`Sensor '${name}' does not support direct queries (no .ask() method).`);

        return await sensor.ask(query);
    }

    // ────────────────────────────────────────────────────────────────────────
    // Event Loop Logic
    // ────────────────────────────────────────────────────────────────────────

    private async handleEvent(sensorName: string, eventSignature: string, payload: any) {
        const fullTrigger = `${sensorName}.${eventSignature}`;

        // Normalize helper: remove quotes and spaces
        const normalize = (s: string) => s.replace(/["'\s]/g, '');
        const normalizedTrigger = normalize(fullTrigger);

        // Find matching tasks
        // We use normalized comparison to handle quotes/spaces differences
        const matchingTasks = Array.from(this.tasks.values()).filter(t =>
            t.active && normalize(t.trigger) === normalizedTrigger
        );

        if (matchingTasks.length === 0) return;

        // Get Context ONCE
        const sensor = this.sensors.get(sensorName);
        if (!sensor) return;
        const context = await sensor.getContext();

        // Get Config for LLM
        const config = this.sensorConfigs.get(sensorName);
        if (!config || !config.minillm) {
            console.error(`[Heartbeat] No LLM config for sensor '${sensorName}'. Cannot execute Pulse.`);
            return;
        }

        for (const task of matchingTasks) {
            this.executeTaskLogic(task, context, config.minillm, sensor);
        }
    }

    private async executeTaskLogic(
        task: HeartbeatTask,
        context: string,
        llmConfig: { model: string, provider: string },
        sensor: Sensor
    ) {
        // 1. Check Repetitions (TTL)
        if (task.maxRepeats && task.maxRepeats > 0) {
            if ((task.remainingRepeats || 0) <= 0) {
                // Should have been deleted, but just in case
                this.deleteTask(task.name);
                return;
            }
        }

        // 2. Pulse Check
        console.log(`[Heartbeat] Pulsing task '${task.name}'...`);
        const result = await Pulse.evaluate(
            context,
            task.condition,
            task.action,
            llmConfig
        );

        if (!result.success) {
            console.log(`[Heartbeat] Task '${task.name}' condition FALSE.`);
            return;
        }

        // 3. Prepare Action
        const actionPrompt = Pulse.interpolate(task.action, result.variables || {});

        // 4. Execute Action (Agent)
        console.log(`[Heartbeat] EXECUTING Action for '${task.name}': "${actionPrompt}"`);

        try {
            // Restore Context
            console.log(`[Heartbeat] Transforming to Agent: ${task.agentName}`);

            // 1. Load Agent Config
            const agentConfig = await this.agentLoader.loadByName(task.agentName);
            if (!agentConfig) {
                console.error(`[Heartbeat] Agent '${task.agentName}' not found. Cannot execute task.`);
                return;
            }

            // 2. Load Tools
            // We use the list saved in the task
            // If task.tools is undefined (old tasks), use defaults
            const toolNames = task.tools || ['files', 'heartbeat'];
            const tools = await this.toolLoader.loadByNames(toolNames);

            // 3. Create Sandbox
            const sandbox = new LocalSandbox({
                // New sandbox for execution
            });

            // Initialize with the CORRECT tools
            await sandbox.initialize(tools);

            // Create Observation wrapper
            const systemMsg = `
> [!IMPORTANT]
> **HEARTBEAT INTERVENTION**
            `;

            // Run Agent with restored identity
            await runAgent({
                agent: task.agentName,
                message: `\`\`\`obs\n${systemMsg}\n${actionPrompt}\n\`\`\``,
                sandbox: sandbox,
                stream: false // Background
            });

            // 5. Cleanup / TTL Update
            if (task.maxRepeats && task.maxRepeats > 0) {
                task.remainingRepeats = (task.remainingRepeats || 0) - 1;
                if (task.remainingRepeats <= 0) {
                    this.deleteTask(task.name);
                    console.log(`[Heartbeat] Task '${task.name}' expired and deleted.`);
                } else {
                    this.saveTasks();
                }
            }

            // Sensor cleanup hook
            if (sensor.onTaskExecuted) {
                await sensor.onTaskExecuted(task.id);
            }

        } catch (e: any) {
            console.error(`[Heartbeat] Action execution failed for '${task.name}':`, e);
        }
    }
}
