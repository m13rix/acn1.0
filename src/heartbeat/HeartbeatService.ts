import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as yaml from 'js-yaml';

import {
  HeartbeatBindingOptions,
  HeartbeatBindingPatch,
  HeartbeatBindingQuery,
  HeartbeatBindingRecord,
  HeartbeatEventRef,
  HeartbeatSensorDescriptor,
  HeartbeatSensorEvent,
  Sensor,
  SensorAskInput,
  SensorConfig,
} from './types.js';
import { LocalSandbox } from '../sandbox/LocalSandbox.js';
import { ToolLoader } from '../loaders/ToolLoader.js';
import { AgentLoader } from '../loaders/AgentLoader.js';
import { getAgentSandbox, getCurrentAgent } from '../core/AgentContext.js';
import { runBackgroundTaskWhenForegroundIdle } from '../core/ExecutionGate.js';
import { serializeHandlerSource, validateHandlerSource } from './handlerSource.js';
import { structuredLlm } from '../utils/structuredLlm.js';
import type { AgentMemoryConfig, LoadedAgent } from '../types/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'data', 'heartbeat');
const DEFAULT_SENSORS_DIR = path.join(ROOT_DIR, 'tools', 'heartbeat', 'sensors');
const DEFAULT_BINDINGS_FILE = path.join(DEFAULT_DATA_DIR, 'bindings.json');
const DEFAULT_TASKS_FILE = path.join(DEFAULT_DATA_DIR, 'tasks.json');

interface HeartbeatPaths {
  dataDir: string;
  sensorsDir: string;
  bindingsFile: string;
  legacyTasksFile: string;
}

interface InitializeOptions {
  enableWatcher?: boolean;
}

interface HeartbeatServiceOptions {
  dataDir?: string;
  sensorsDir?: string;
  bindingsFile?: string;
  legacyTasksFile?: string;
  toolLoader?: ToolLoader;
  agentLoader?: AgentLoader;
}

type LoadedSensor = {
  runtime: Sensor;
  descriptor: HeartbeatSensorDescriptor;
};

function defaultPaths(options: HeartbeatServiceOptions = {}): HeartbeatPaths {
  const dataDir = options.dataDir || process.env.HEARTBEAT_DATA_DIR || DEFAULT_DATA_DIR;
  const sensorsDir = options.sensorsDir || process.env.HEARTBEAT_SENSORS_DIR || DEFAULT_SENSORS_DIR;
  return {
    dataDir,
    sensorsDir,
    bindingsFile: options.bindingsFile || path.join(dataDir, 'bindings.json'),
    legacyTasksFile: options.legacyTasksFile || path.join(dataDir, 'tasks.json'),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function formatLogValue(value: unknown): string {
  try {
    return stableStringify(value);
  } catch (error) {
    return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function sameArgs(left: unknown[], right: unknown[]): boolean {
  return stableStringify(left) === stableStringify(right);
}

function shouldLogEventDispatch(event: HeartbeatSensorEvent, matchingCount: number): boolean {
  if (matchingCount > 0) {
    return true;
  }

  if (event.sensor === 'clock') {
    return false;
  }

  return true;
}

function ensureEventRef(eventRef: HeartbeatEventRef): HeartbeatEventRef {
  if (!eventRef || typeof eventRef !== 'object') {
    throw new Error('eventRef must be an object.');
  }
  if (typeof eventRef.sensor !== 'string' || !eventRef.sensor.trim()) {
    throw new Error('eventRef.sensor must be a non-empty string.');
  }
  if (typeof eventRef.event !== 'string' || !eventRef.event.trim()) {
    throw new Error('eventRef.event must be a non-empty string.');
  }
  if (!Array.isArray(eventRef.args)) {
    throw new Error('eventRef.args must be an array.');
  }

  return {
    sensor: eventRef.sensor.trim(),
    event: eventRef.event.trim(),
    args: [...eventRef.args],
  };
}

function cloneBinding(record: HeartbeatBindingRecord): HeartbeatBindingRecord {
  return JSON.parse(JSON.stringify(record)) as HeartbeatBindingRecord;
}

function projectBinding(record: HeartbeatBindingRecord, query?: HeartbeatBindingQuery): Record<string, unknown> {
  const includeCode = query?.includeCode ?? false;
  const fields = query?.fields;
  const copy = cloneBinding(record) as unknown as Record<string, unknown>;

  if (!includeCode) {
    delete copy.handlerSource;
  }

  if (!fields || fields.length === 0) {
    return copy;
  }

  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'handlerSource' && !includeCode) {
      continue;
    }
    if (field in copy) {
      result[field] = copy[field];
    }
  }
  return result;
}

function normalizeToolSnapshot(toolNames: string[]): string[] {
  const ordered = new Set<string>();
  for (const toolName of toolNames) {
    const trimmed = String(toolName || '').trim();
    if (trimmed) {
      ordered.add(trimmed);
    }
  }
  ordered.add('heartbeat');
  return Array.from(ordered);
}

const CLOCK_WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const CLOCK_WEEKDAY_ALIASES: Record<string, (typeof CLOCK_WEEKDAYS)[number]> = {
  sun: 'sunday',
  sunday: 'sunday',
  mon: 'monday',
  monday: 'monday',
  tue: 'tuesday',
  tues: 'tuesday',
  tuesday: 'tuesday',
  wed: 'wednesday',
  weds: 'wednesday',
  wednesday: 'wednesday',
  thu: 'thursday',
  thur: 'thursday',
  thurs: 'thursday',
  thursday: 'thursday',
  fri: 'friday',
  friday: 'friday',
  sat: 'saturday',
  saturday: 'saturday',
};

interface ClockScheduleRule {
  days: string[];
  times: string[];
  label?: string;
}

interface ClockScheduleDefinition {
  rules: ClockScheduleRule[];
}

interface ClockScheduleMatch {
  matchedRuleIndexes: number[];
  matchedRules: ClockScheduleRule[];
}

interface ClockEveryDefinition {
  normalized: string;
  totalMs: number;
}

const CLOCK_INTERVAL_UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const CLOCK_CIVIL_EPOCH_MS = Date.UTC(1970, 0, 1, 0, 0, 0, 0);

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function getClockWeekday(now: Date): (typeof CLOCK_WEEKDAYS)[number] {
  return CLOCK_WEEKDAYS[now.getDay()]!;
}

function getClockTime(now: Date): string {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function normalizeClockWeekday(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = CLOCK_WEEKDAY_ALIASES[value.trim().toLowerCase()];
  return normalized || null;
}

function normalizeClockTime(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return `${pad2(hours)}:${pad2(minutes)}`;
}

function parseClockEveryDefinition(args: unknown[]): ClockEveryDefinition | null {
  if (!Array.isArray(args) || args.length !== 1 || typeof args[0] !== 'string') {
    return null;
  }

  const raw = args[0].trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const matcher = /(\d+)\s*([smhd])/g;
  let totalMs = 0;
  let normalized = '';
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(raw)) !== null) {
    if (match.index !== consumed) {
      return null;
    }

    const amount = Number(match[1]);
    const unit = match[2] as keyof typeof CLOCK_INTERVAL_UNIT_MS;
    const unitMs = CLOCK_INTERVAL_UNIT_MS[unit];
    if (!Number.isInteger(amount) || amount <= 0 || !unitMs) {
      return null;
    }

    totalMs += amount * unitMs;
    normalized += `${amount}${unit}`;
    consumed = matcher.lastIndex;
  }

  if (consumed !== raw.length || totalMs <= 0) {
    return null;
  }

  return { normalized, totalMs };
}

function getClockEverySecondMs(now: Date): number {
  return Math.floor(now.getTime() / 1000) * 1000;
}

function getClockCivilTimestampMs(now: Date): number {
  return Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
    0,
  );
}

function doesClockEveryMatch(definition: ClockEveryDefinition, now: Date): boolean {
  const occurrenceCivilMs = getClockCivilTimestampMs(now);
  return (occurrenceCivilMs - CLOCK_CIVIL_EPOCH_MS) % definition.totalMs === 0;
}

function parseClockScheduleDefinition(args: unknown[]): ClockScheduleDefinition | null {
  if (!Array.isArray(args) || args.length !== 1) {
    return null;
  }

  const [rawDefinition] = args;
  if (!isPlainObject(rawDefinition)) {
    return null;
  }

  const rulesValue = rawDefinition['rules'];
  if (!Array.isArray(rulesValue) || rulesValue.length === 0) {
    return null;
  }

  const rules: ClockScheduleRule[] = [];
  for (const ruleValue of rulesValue) {
    if (!isPlainObject(ruleValue)) {
      return null;
    }

    const rawDays = ruleValue['days'];
    const rawTimes = ruleValue['times'];
    if (!Array.isArray(rawDays) || !Array.isArray(rawTimes) || rawDays.length === 0 || rawTimes.length === 0) {
      return null;
    }

    const days = rawDays.map(normalizeClockWeekday);
    const times = rawTimes.map(normalizeClockTime);
    if (days.some(day => !day) || times.some(time => !time)) {
      return null;
    }

    const rule: ClockScheduleRule = {
      days: Array.from(new Set(days as string[])),
      times: Array.from(new Set(times as string[])),
    };

    const label = ruleValue['label'];
    if (typeof label === 'string' && label.trim()) {
      rule.label = label.trim();
    }

    rules.push(rule);
  }

  return { rules };
}

function getClockScheduleMatch(schedule: ClockScheduleDefinition, now: Date): ClockScheduleMatch | null {
  const weekday = getClockWeekday(now);
  const time = getClockTime(now);
  const matchedRuleIndexes: number[] = [];
  const matchedRules: ClockScheduleRule[] = [];

  schedule.rules.forEach((rule, index) => {
    if (rule.days.includes(weekday) && rule.times.includes(time)) {
      matchedRuleIndexes.push(index);
      matchedRules.push(rule);
    }
  });

  if (matchedRuleIndexes.length === 0) {
    return null;
  }

  return { matchedRuleIndexes, matchedRules };
}

export class HeartbeatService extends EventEmitter {
  private static instance: HeartbeatService;

  private readonly paths: HeartbeatPaths;
  private readonly toolLoader: ToolLoader;
  private readonly agentLoader: AgentLoader;
  private readonly bindings = new Map<string, HeartbeatBindingRecord>();
  private readonly sensors = new Map<string, LoadedSensor>();

  private initialized = false;
  private initializing = false;
  private started = false;
  private bindingsWatcher?: fs.FSWatcher;
  private lastClockEverySecondMs: number | null = null;

  public constructor(options: HeartbeatServiceOptions = {}) {
    super();
    this.paths = defaultPaths(options);
    this.toolLoader = options.toolLoader || new ToolLoader();
    this.agentLoader = options.agentLoader || new AgentLoader();
    this.ensureDataDir();
  }

  public static getInstance(): HeartbeatService {
    if (!HeartbeatService.instance) {
      HeartbeatService.instance = new HeartbeatService();
    }
    return HeartbeatService.instance;
  }

  private log(message: string, details?: unknown): void {
    if (typeof details === 'undefined') {
      console.log(`[Heartbeat] ${message}`);
      return;
    }
    console.log(`[Heartbeat] ${message}`, details);
  }

  private ensureDataDir(): void {
    if (!fs.existsSync(this.paths.dataDir)) {
      fs.mkdirSync(this.paths.dataDir, { recursive: true });
    }
  }

  public async initialize(options: InitializeOptions = {}): Promise<void> {
    if (this.initialized || this.initializing) {
      return;
    }
    this.initializing = true;
    try {
      this.archiveLegacyTasksIfNeeded();
      this.loadBindings();

      if (options.enableWatcher !== false) {
        this.watchBindings();
      }

      await this.loadSensors();

      this.initialized = true;
      this.log(`Initialized with ${this.bindings.size} binding(s) and ${this.sensors.size} sensor(s).`);
      if (this.bindings.size > 0) {
        this.log(`Loaded binding IDs: ${Array.from(this.bindings.keys()).join(', ')}`);
      }
    } finally {
      this.initializing = false;
    }
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    for (const [sensorName, sensor] of this.sensors) {
      try {
        this.log(`Starting sensor '${sensorName}'.`);
        await sensor.runtime.start((event) => {
          void this.dispatchEvent({
            sensor: sensorName,
            event: event.event,
            args: Array.isArray(event.args) ? event.args : [],
            payload: event.payload,
            occurredAt: event.occurredAt || new Date().toISOString(),
          });
        });
        this.log(`Sensor '${sensorName}' started.`);
      } catch (error) {
        console.error(`[Heartbeat] Failed to start sensor '${sensorName}':`, error);
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.bindingsWatcher) {
      this.bindingsWatcher.close();
      this.bindingsWatcher = undefined;
    }

    const stops = Array.from(this.sensors.values()).map(sensor => sensor.runtime.stop());
    await Promise.allSettled(stops);
    this.started = false;
    this.lastClockEverySecondMs = null;
  }

  private archiveLegacyTasksIfNeeded(): void {
    const tasksFile = this.paths.legacyTasksFile;
    if (!fs.existsSync(tasksFile)) {
      return;
    }

    const content = fs.readFileSync(tasksFile, 'utf-8').trim();
    if (!content) {
      fs.unlinkSync(tasksFile);
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivedPath = path.join(this.paths.dataDir, `tasks.legacy.${timestamp}.json`);
    fs.renameSync(tasksFile, archivedPath);
  }

  private loadBindings(): void {
    this.ensureDataDir();
    if (!fs.existsSync(this.paths.bindingsFile)) {
      this.bindings.clear();
      return;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(this.paths.bindingsFile, 'utf-8'));
      const next = new Map<string, HeartbeatBindingRecord>();
      if (Array.isArray(raw)) {
        for (const candidate of raw) {
          if (!candidate || typeof candidate !== 'object') {
            continue;
          }
          const record = candidate as HeartbeatBindingRecord;
          if (typeof record.id !== 'string' || !record.id) {
            continue;
          }
          next.set(record.id, {
            ...record,
            eventRef: ensureEventRef(record.eventRef),
            toolNames: normalizeToolSnapshot(Array.isArray(record.toolNames) ? record.toolNames : []),
            enabled: record.enabled !== false,
          });
        }
      }

      this.bindings.clear();
      for (const [id, record] of next) {
        this.bindings.set(id, record);
      }
    } catch (error) {
      console.error('[Heartbeat] Failed to load bindings:', error);
    }
  }

  private saveBindings(): void {
    const records = Array.from(this.bindings.values()).map(binding => cloneBinding(binding));
    fs.writeFileSync(this.paths.bindingsFile, JSON.stringify(records, null, 2), 'utf-8');
  }

  private watchBindings(): void {
    this.ensureDataDir();
    if (this.bindingsWatcher) {
      return;
    }

    try {
      this.bindingsWatcher = fs.watch(this.paths.dataDir, (_eventType, filename) => {
        if (!filename || filename !== path.basename(this.paths.bindingsFile)) {
          return;
        }
        this.loadBindings();
      });
    } catch (error) {
      console.warn('[Heartbeat] Failed to watch bindings:', error);
    }
  }

  private async loadSensors(): Promise<void> {
    this.sensors.clear();

    if (!fs.existsSync(this.paths.sensorsDir)) {
      return;
    }

    const entries = fs.readdirSync(this.paths.sensorsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const sensorDir = path.join(this.paths.sensorsDir, entry.name);
      const configPath = path.join(sensorDir, 'sensor.yaml');
      const modulePath = path.join(sensorDir, 'index.ts');

      if (!fs.existsSync(configPath) || !fs.existsSync(modulePath)) {
        continue;
      }

      try {
        const config = yaml.load(fs.readFileSync(configPath, 'utf-8')) as SensorConfig;
        if (!config?.name || !Array.isArray(config.events)) {
          throw new Error(`Invalid sensor config for ${entry.name}`);
        }

        const module = await import(pathToFileURL(modulePath).href);
        const runtime: Sensor = {
          start: module.start,
          stop: module.stop,
          getContext: module.getContext,
          ask: module.ask,
        };

        if (typeof runtime.start !== 'function' || typeof runtime.stop !== 'function') {
          throw new Error(`Sensor '${entry.name}' must export start() and stop().`);
        }

        this.sensors.set(config.name, {
          runtime,
          descriptor: {
            name: config.name,
            description: config.description || '',
            events: config.events,
          },
        });
      } catch (error) {
        console.error(`[Heartbeat] Failed to load sensor '${entry.name}':`, error);
      }
    }
  }

  public getSensorDescriptors(): HeartbeatSensorDescriptor[] {
    return Array.from(this.sensors.values()).map(sensor => JSON.parse(JSON.stringify(sensor.descriptor)) as HeartbeatSensorDescriptor);
  }

  public getSensorDescriptor(name: string): HeartbeatSensorDescriptor | null {
    const sensor = this.sensors.get(name);
    return sensor ? JSON.parse(JSON.stringify(sensor.descriptor)) as HeartbeatSensorDescriptor : null;
  }

  public createEventRef(sensor: string, event: string, args: unknown[] = []): HeartbeatEventRef {
    const descriptor = this.sensors.get(sensor)?.descriptor;
    if (!descriptor) {
      throw new Error(`Unknown heartbeat sensor '${sensor}'.`);
    }
    if (!descriptor.events.some(item => item.name === event)) {
      throw new Error(`Unknown event '${event}' for sensor '${sensor}'.`);
    }
    return ensureEventRef({ sensor, event, args });
  }

  private async resolveCreatorContext(): Promise<{
    ownerAgent: string;
    toolNames: string[];
    memoryConfig?: AgentMemoryConfig;
    loadedAgent?: LoadedAgent | null;
  }> {
    const fromContext = getCurrentAgent();
    const explicitAgentName = fromContext?.config.name || (process.env.TELOS_AGENT_NAME || '').trim();
    const ownerAgent = explicitAgentName || 'CORE';
    const loadedAgent = explicitAgentName
      ? (fromContext || await this.agentLoader.loadByName(explicitAgentName))
      : (fromContext || null);

    const sandbox = getAgentSandbox();
    let toolNames: string[] = [];
    if (sandbox instanceof LocalSandbox) {
      toolNames = sandbox.getTools().map(tool => tool.config.name);
    } else if (loadedAgent?.config) {
      toolNames = [...(loadedAgent.config.tools || [])];
      toolNames.push('files');
      if (loadedAgent.config.memory?.enabled !== false) {
        toolNames.push('memory');
      }
    }

    return {
      ownerAgent,
      toolNames: normalizeToolSnapshot(toolNames),
      memoryConfig: loadedAgent?.config.memory,
      loadedAgent,
    };
  }

  public async bind(
    eventRef: HeartbeatEventRef,
    handler: Function,
    options: HeartbeatBindingOptions = {}
  ): Promise<HeartbeatBindingRecord> {
    const normalizedEventRef = ensureEventRef(eventRef);
    this.createEventRef(normalizedEventRef.sensor, normalizedEventRef.event, normalizedEventRef.args);

    const creator = await this.resolveCreatorContext();
    const handlerSource = serializeHandlerSource(handler, creator.toolNames);
    const now = new Date().toISOString();
    const id = options.id?.trim() || `hb_${randomUUID()}`;

    if (this.bindings.has(id)) {
      throw new Error(`Heartbeat binding '${id}' already exists.`);
    }

    const record: HeartbeatBindingRecord = {
      id,
      eventRef: normalizedEventRef,
      handlerSource,
      ownerAgent: creator.ownerAgent,
      toolNames: creator.toolNames,
      memoryConfig: creator.memoryConfig,
      metadata: options.metadata,
      enabled: options.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };

    this.bindings.set(record.id, record);
    this.saveBindings();
    return cloneBinding(record);
  }

  public listBindings(query: HeartbeatBindingQuery = {}): Record<string, unknown>[] {
    return Array.from(this.bindings.values())
      .filter(binding => {
        if (query.ids && query.ids.length > 0 && !query.ids.includes(binding.id)) {
          return false;
        }
        if (query.sensor && binding.eventRef.sensor !== query.sensor) {
          return false;
        }
        if (query.event && binding.eventRef.event !== query.event) {
          return false;
        }
        if (query.ownerAgent && binding.ownerAgent !== query.ownerAgent) {
          return false;
        }
        return true;
      })
      .map(binding => projectBinding(binding, query));
  }

  public getBinding(id: string, query: HeartbeatBindingQuery = {}): Record<string, unknown> | null {
    const binding = this.bindings.get(id);
    if (!binding) {
      return null;
    }
    return projectBinding(binding, query);
  }

  public unbind(id: string): { ok: true } {
    if (!this.bindings.delete(id)) {
      throw new Error(`Heartbeat binding '${id}' not found.`);
    }
    this.saveBindings();
    return { ok: true };
  }

  public async rebind(id: string, patch: HeartbeatBindingPatch): Promise<HeartbeatBindingRecord> {
    const binding = this.bindings.get(id);
    if (!binding) {
      throw new Error(`Heartbeat binding '${id}' not found.`);
    }

    if (patch.eventRef) {
      binding.eventRef = ensureEventRef(patch.eventRef);
      this.createEventRef(binding.eventRef.sensor, binding.eventRef.event, binding.eventRef.args);
    }
    if (typeof patch.enabled === 'boolean') {
      binding.enabled = patch.enabled;
    }
    if (patch.metadata) {
      binding.metadata = patch.metadata;
    }
    if (patch.handler || patch.handlerSource) {
      const allowedIdentifiers = normalizeToolSnapshot(binding.toolNames);
      binding.handlerSource = patch.handler
        ? serializeHandlerSource(patch.handler, allowedIdentifiers)
        : validateHandlerSource(String(patch.handlerSource || '').trim(), allowedIdentifiers);
    }

    binding.updatedAt = new Date().toISOString();
    this.saveBindings();
    return cloneBinding(binding);
  }

  public async askSensor(name: string, input: SensorAskInput): Promise<unknown> {
    const sensor = this.sensors.get(name);
    if (!sensor) {
      throw new Error(`Sensor '${name}' not found.`);
    }

    this.log(`askSensor('${name}') request`, {
      prompt: input.prompt,
      schema: input.schema,
      imagePath: input.imagePath || null,
      usesNativeAsk: typeof sensor.runtime.ask === 'function',
    });

    if (sensor.runtime.ask) {
      const result = await sensor.runtime.ask(input);
      this.log(`askSensor('${name}') response: ${formatLogValue(result)}`);
      return result;
    }

    if (!sensor.runtime.getContext) {
      throw new Error(`Sensor '${name}' does not support ask().`);
    }

    const context = await sensor.runtime.getContext();
    const prompt = [
      `Sensor: ${name}`,
      `Description: ${sensor.descriptor.description}`,
      '',
      'Sensor context:',
      context,
      '',
      'User request:',
      input.prompt,
    ].join('\n');

    const result = await structuredLlm(prompt, input.schema as any, input.imagePath);
    this.log(`askSensor('${name}') response: ${formatLogValue(result)}`);
    return result;
  }

  public async dispatchEvent(event: HeartbeatSensorEvent): Promise<void> {
    const normalized: HeartbeatSensorEvent = {
      sensor: event.sensor,
      event: event.event,
      args: Array.isArray(event.args) ? event.args : [],
      payload: event.payload,
      occurredAt: event.occurredAt || new Date().toISOString(),
    };

    if (normalized.sensor === 'clock' && normalized.event === 'every') {
      const occurrence = new Date(normalized.occurredAt);
      const occurrenceSecondMs = getClockEverySecondMs(occurrence);
      if (!Number.isFinite(occurrenceSecondMs)) {
        console.warn(`[Heartbeat] Ignoring invalid clock.every occurrence '${normalized.occurredAt}'.`);
        return;
      }

      if (this.lastClockEverySecondMs === occurrenceSecondMs) {
        return;
      }
      this.lastClockEverySecondMs = occurrenceSecondMs;

      const matching = Array.from(this.bindings.values()).flatMap((binding) => {
        if (!binding.enabled || binding.eventRef.sensor !== 'clock' || binding.eventRef.event !== 'every') {
          return [];
        }

        const definition = parseClockEveryDefinition(binding.eventRef.args);
        if (!definition || !doesClockEveryMatch(definition, occurrence)) {
          return [];
        }

        const payload = isPlainObject(normalized.payload)
          ? {
              ...normalized.payload,
              every: {
                interval: definition.normalized,
                milliseconds: definition.totalMs,
              },
            }
          : normalized.payload;

        return [{
          binding,
          event: {
            ...normalized,
            args: binding.eventRef.args,
            payload,
            occurredAt: new Date(occurrenceSecondMs).toISOString(),
          } as HeartbeatSensorEvent,
        }];
      });

      if (shouldLogEventDispatch(normalized, matching.length)) {
        this.log(`Event '${normalized.sensor}.${normalized.event}' received with ${matching.length} matching binding(s).`, {
          args: normalized.args,
          occurredAt: new Date(occurrenceSecondMs).toISOString(),
          bindingIds: matching.map(item => item.binding.id),
        });
      }

      await Promise.all(matching.map(item => this.executeBinding(item.binding, item.event)));
      return;
    }

    if (normalized.sensor === 'clock' && normalized.event === 'schedule') {
      const occurrence = new Date(normalized.occurredAt);
      const matching = Array.from(this.bindings.values()).flatMap((binding) => {
        if (!binding.enabled || binding.eventRef.sensor !== 'clock' || binding.eventRef.event !== 'schedule') {
          return [];
        }

        const schedule = parseClockScheduleDefinition(binding.eventRef.args);
        if (!schedule) {
          console.warn(`[Heartbeat] Ignoring invalid clock.schedule binding '${binding.id}': schedule args must contain a single { rules: [...] } object.`);
          return [];
        }

        const match = getClockScheduleMatch(schedule, occurrence);
        if (!match) {
          return [];
        }

        const payload = isPlainObject(normalized.payload)
          ? {
              ...normalized.payload,
              schedule: {
                matchedRuleIndexes: match.matchedRuleIndexes,
                matchedRules: match.matchedRules,
                localWeekday: getClockWeekday(occurrence),
                localTime: getClockTime(occurrence),
              },
            }
          : normalized.payload;

        return [{
          binding,
          event: {
            ...normalized,
            args: binding.eventRef.args,
            payload,
          } as HeartbeatSensorEvent,
        }];
      });

      if (shouldLogEventDispatch(normalized, matching.length)) {
        this.log(`Event '${normalized.sensor}.${normalized.event}' received with ${matching.length} matching binding(s).`, {
          args: normalized.args,
          occurredAt: normalized.occurredAt,
          bindingIds: matching.map(item => item.binding.id),
        });
      }

      await Promise.all(matching.map(item => this.executeBinding(item.binding, item.event)));
      return;
    }

    const matching = Array.from(this.bindings.values()).filter(binding =>
      binding.enabled
      && binding.eventRef.sensor === normalized.sensor
      && binding.eventRef.event === normalized.event
      && sameArgs(binding.eventRef.args, normalized.args)
    );

    if (shouldLogEventDispatch(normalized, matching.length)) {
      this.log(`Event '${normalized.sensor}.${normalized.event}' received with ${matching.length} matching binding(s).`, {
        args: normalized.args,
        occurredAt: normalized.occurredAt,
        bindingIds: matching.map(binding => binding.id),
      });
    }

    await Promise.all(matching.map(binding => this.executeBinding(binding, normalized)));
  }

  private async executeBinding(binding: HeartbeatBindingRecord, event: HeartbeatSensorEvent): Promise<void> {
    await runBackgroundTaskWhenForegroundIdle(async () => {
      const toolNames = normalizeToolSnapshot(binding.toolNames);
      const tools = await this.toolLoader.loadByNames(toolNames);
      const sandbox = new LocalSandbox();

      try {
        this.log(`Executing binding '${binding.id}' for event '${event.sensor}.${event.event}'.`);
        await sandbox.initialize(tools, binding.memoryConfig);
        const runtimeEvent = {
          ...event,
          bindingId: binding.id,
        };

        const code = `
const __binding = ${JSON.stringify(cloneBinding(binding))};
const __event = ${JSON.stringify(runtimeEvent)};
const __handler = (${binding.handlerSource});

if (typeof __handler !== 'function') {
  throw new Error('Persisted heartbeat handler did not restore to a function.');
}

const ctx = {
  binding: __binding,
  async unbind(id = __binding.id) {
    return await heartbeat.bindings.unbind(id);
  },
  async rebind(patch) {
    return await heartbeat.bindings.rebind(__binding.id, patch);
  },
};

const __handlerResult = await __handler(__event, ctx);
if (typeof __handlerResult !== 'undefined') {
  try {
    const serialized = typeof __handlerResult === 'string'
      ? __handlerResult
      : JSON.stringify(__handlerResult);
    console.log('[Heartbeat Handler Result] ' + serialized);
  } catch (error) {
    console.log('[Heartbeat Handler Result] [unserializable: ' + (error instanceof Error ? error.message : String(error)) + ']');
  }
}
`;

        const result = await sandbox.execute(code, undefined, {
          TELOS_AGENT_NAME: binding.ownerAgent,
          TELOS_API_URL: process.env.TELOS_API_URL || '',
          TELOS_CHAT_ID: 'HEARTBEAT_ROUTE',
          HEARTBEAT_DATA_DIR: this.paths.dataDir,
          HEARTBEAT_SENSORS_DIR: this.paths.sensorsDir,
        }, (chunk) => process.stderr.write(chunk));

        if (!result.success) {
          console.error(`[Heartbeat] Binding '${binding.id}' failed:`, result.error || result.output);
          return;
        }

        const output = String(result.output || '').trim();
        if (output && output !== '(no output)') {
          this.log(`Binding '${binding.id}' completed with output:\n${output}`);
        } else {
          this.log(`Binding '${binding.id}' completed successfully.`);
        }
      } catch (error) {
        console.error(`[Heartbeat] Binding '${binding.id}' execution failed:`, error);
      } finally {
        await sandbox.cleanup();
      }
    });
  }
}
