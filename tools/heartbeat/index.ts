import { HeartbeatService } from '../../src/heartbeat/HeartbeatService.js';
import type {
  HeartbeatBindingOptions,
  HeartbeatBindingPatch,
  HeartbeatBindingQuery,
  HeartbeatEventRef,
} from '../../src/heartbeat/types.js';
import { sendRequest } from '../srcAgent/index.js';

const service = HeartbeatService.getInstance();

let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = service.initialize({ enableWatcher: false }).catch((error) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}

function createEventProxy(sensorName: string): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }
      if (typeof property !== 'string') {
        return undefined;
      }

      return (...args: unknown[]): HeartbeatEventRef => ({
        sensor: sensorName,
        event: property,
        args,
      });
    },
  });
}

function createSensorProxy(sensorName: string): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, property) {
      if (property === 'then') {
        return undefined;
      }
      if (property === 'events') {
        return createEventProxy(sensorName);
      }

      if (property === 'ask') {
        return async (prompt: string, schema: unknown, imagePath?: string) => {
          await ensureInitialized();
          return service.askSensor(sensorName, {
            prompt,
            schema: schema as any,
            imagePath,
          });
        };
      }

      if (property === 'descriptor') {
        return async () => {
          await ensureInitialized();
          return service.getSensorDescriptor(sensorName);
        };
      }

      return undefined;
    },
  });
}

export async function bind(
  eventRef: HeartbeatEventRef,
  handler: Function,
  options?: HeartbeatBindingOptions
) {
  await ensureInitialized();
  return service.bind(eventRef, handler, options);
}

export const bindings = {
  list: async (query?: HeartbeatBindingQuery) => {
    await ensureInitialized();
    return service.listBindings(query);
  },
  get: async (id: string, query?: HeartbeatBindingQuery) => {
    await ensureInitialized();
    return service.getBinding(id, query);
  },
  unbind: async (id: string) => {
    await ensureInitialized();
    return service.unbind(id);
  },
  rebind: async (id: string, patch: HeartbeatBindingPatch) => {
    await ensureInitialized();
    return service.rebind(id, patch);
  },
};

export const sensors = new Proxy({
  list: async () => {
    await ensureInitialized();
    return service.getSensorDescriptors();
  },
  create: async (prompt: string) => {
    const geminiPrompt = `
You act as an expert developer creating a new ACN Heartbeat V2 sensor module.
User Request: ${prompt}

Create a sensor in:
tools/heartbeat/sensors/[name]/
  - index.ts
  - sensor.yaml

Contract:
- index.ts exports:
  - start(emit)
  - stop()
  - getContext?()
  - ask?(input)
- Sensors emit structured events:
  emit({ event: "name", args: [...], payload: {...}, occurredAt?: ISOString })
- sensor.yaml must define:
  - name
  - description
  - events[] with description, argsSchema, payloadSchema

The generated sensor should be elegant, LLM-friendly, and compatible with persistent heartbeat bindings.
`.trim();

    return sendRequest(geminiPrompt);
  },
}, {
  get(target, property, receiver) {
    if (property === 'then') {
      return undefined;
    }
    if (Reflect.has(target, property)) {
      return Reflect.get(target, property, receiver);
    }

    if (typeof property !== 'string') {
      return undefined;
    }

    return createSensorProxy(property);
  },
});

void ensureInitialized();
