import type { AgentMemoryConfig } from '../types/index.js';
import type { JsonSchema } from '../utils/structuredLlm.js';
import type { ZodTypeAny } from 'zod';

export interface HeartbeatEventRef {
  sensor: string;
  event: string;
  args: unknown[];
}

export interface HeartbeatSensorEvent {
  sensor: string;
  event: string;
  args: unknown[];
  payload?: unknown;
  occurredAt: string;
}

export interface HeartbeatBindingRecord {
  id: string;
  eventRef: HeartbeatEventRef;
  handlerSource: string;
  ownerAgent: string;
  toolNames: string[];
  skillsTable?: string;
  memoryConfig?: AgentMemoryConfig;
  metadata?: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HeartbeatBindingOptions {
  id?: string;
  enabled?: boolean;
  metadata?: Record<string, unknown>;
}

export interface HeartbeatBindingPatch {
  eventRef?: HeartbeatEventRef;
  handler?: Function;
  handlerSource?: string;
  metadata?: Record<string, unknown>;
  enabled?: boolean;
}

export interface HeartbeatBindingQuery {
  ids?: string[];
  sensor?: string;
  event?: string;
  ownerAgent?: string;
  includeCode?: boolean;
  fields?: Array<keyof HeartbeatBindingRecord>;
}

export interface HeartbeatSensorEventDescriptor {
  name: string;
  description: string;
  argsSchema?: JsonSchema;
  payloadSchema?: JsonSchema;
}

export interface HeartbeatSensorDescriptor {
  name: string;
  description: string;
  events: HeartbeatSensorEventDescriptor[];
}

export interface SensorAskInput {
  prompt: string;
  schema: ZodTypeAny | JsonSchema;
  imagePath?: string;
}

export interface Sensor {
  start(emit: (event: Omit<HeartbeatSensorEvent, 'sensor'>) => void): Promise<void>;
  stop(): Promise<void>;
  getContext?(): Promise<string>;
  ask?(input: SensorAskInput): Promise<unknown>;
}

export interface SensorConfig {
  name: string;
  description: string;
  events: HeartbeatSensorEventDescriptor[];
  [key: string]: unknown;
}
