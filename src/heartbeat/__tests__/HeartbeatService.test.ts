import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

import { HeartbeatService } from '../HeartbeatService.js';

async function createTempHeartbeatLayout(): Promise<{ root: string; dataDir: string; sensorsDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'heartbeat-v2-'));
  const dataDir = path.join(root, 'data');
  const sensorsDir = path.join(root, 'sensors');
  await mkdir(dataDir, { recursive: true });
  await mkdir(sensorsDir, { recursive: true });
  return { root, dataDir, sensorsDir };
}

async function writeStubSensor(sensorsDir: string): Promise<void> {
  const sensorDir = path.join(sensorsDir, 'demo');
  await mkdir(sensorDir, { recursive: true });

  await writeFile(path.join(sensorDir, 'sensor.yaml'), `
name: demo
description: Demo sensor
events:
  - name: ping
    description: Emits a ping event
    argsSchema:
      type: array
      items:
        - type: string
      minItems: 1
      maxItems: 1
    payloadSchema:
      type: object
      additionalProperties: false
      properties:
        value:
          type: string
      required:
        - value
`.trim(), 'utf-8');

  await writeFile(path.join(sensorDir, 'index.ts'), `
export async function start() {}
export async function stop() {}
export async function getContext() {
  return 'demo context';
}
`, 'utf-8');
}

async function writeClockSensor(sensorsDir: string): Promise<void> {
  const sensorDir = path.join(sensorsDir, 'clock');
  await mkdir(sensorDir, { recursive: true });

  await writeFile(path.join(sensorDir, 'sensor.yaml'), `
name: clock
description: Time-based heartbeat sensor.
events:
  - name: every
    description: Fires on arbitrary supported intervals.
    argsSchema:
      type: array
      items:
        - type: string
      minItems: 1
      maxItems: 1
    payloadSchema:
      type: object
      additionalProperties: false
      properties:
        iso:
          type: string
        localeTime:
          type: string
        localeDate:
          type: string
        weekday:
          type: string
        hour:
          type: integer
        minute:
          type: integer
        second:
          type: integer
        timestamp:
          type: integer
      required:
        - iso
        - localeTime
        - localeDate
        - weekday
        - hour
        - minute
        - second
        - timestamp
  - name: schedule
    description: Fires on configured local weekdays and HH:MM times.
    argsSchema:
      type: array
      items:
        - type: object
          additionalProperties: false
          properties:
            rules:
              type: array
              minItems: 1
              items:
                type: object
                additionalProperties: false
                properties:
                  days:
                    type: array
                    minItems: 1
                    items:
                      type: string
                  times:
                    type: array
                    minItems: 1
                    items:
                      type: string
                required:
                  - days
                  - times
          required:
            - rules
      minItems: 1
      maxItems: 1
    payloadSchema:
      type: object
      additionalProperties: false
      properties:
        iso:
          type: string
        localeTime:
          type: string
        localeDate:
          type: string
        weekday:
          type: string
        hour:
          type: integer
        minute:
          type: integer
        second:
          type: integer
        timestamp:
          type: integer
        schedule:
          type: object
          additionalProperties: false
          properties:
            matchedRuleIndexes:
              type: array
              items:
                type: integer
            matchedRules:
              type: array
              items:
                type: object
                additionalProperties: false
                properties:
                  days:
                    type: array
                    items:
                      type: string
                  times:
                    type: array
                    items:
                      type: string
                required:
                  - days
                  - times
            localWeekday:
              type: string
            localTime:
              type: string
          required:
            - matchedRuleIndexes
            - matchedRules
            - localWeekday
            - localTime
      required:
        - iso
        - localeTime
        - localeDate
        - weekday
        - hour
        - minute
        - second
        - timestamp
        - schedule
`.trim(), 'utf-8');

  await writeFile(path.join(sensorDir, 'index.ts'), `
export async function start() {}
export async function stop() {}
`, 'utf-8');
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('persists bindings, projects list/get queries, and reacts to handler-driven rebind', async () => {
  const layout = await createTempHeartbeatLayout();
  await writeStubSensor(layout.sensorsDir);

  const service = new HeartbeatService({
    dataDir: layout.dataDir,
    sensorsDir: layout.sensorsDir,
  });

  try {
    await service.initialize({ enableWatcher: true });
    const binding = await service.bind(
      service.createEventRef('demo', 'ping', ['alpha']),
      async (_event: any, ctx: any) => {
        await ctx.rebind({ metadata: { fired: true } });
      },
      { id: 'demo-binding', metadata: { fired: false } }
    );

    assert.equal(binding.id, 'demo-binding');

    const list = service.listBindings({ includeCode: false });
    assert.equal(list.length, 1);
    assert.equal((list[0] as any)?.handlerSource, undefined);

    const projected = service.getBinding('demo-binding', {
      includeCode: true,
      fields: ['id', 'handlerSource', 'metadata'],
    }) as Record<string, any>;
    assert.equal(projected.id, 'demo-binding');
    assert.equal(projected.metadata.fired, false);
    assert.match(projected.handlerSource, /ctx\.rebind/);

    const reloaded = new HeartbeatService({
      dataDir: layout.dataDir,
      sensorsDir: layout.sensorsDir,
    });
    await reloaded.initialize({ enableWatcher: false });
    const persisted = reloaded.getBinding('demo-binding', { includeCode: true }) as Record<string, any>;
    assert.equal(persisted.id, 'demo-binding');

    await service.dispatchEvent({
      sensor: 'demo',
      event: 'ping',
      args: ['alpha'],
      payload: { value: 'ok' },
      occurredAt: new Date().toISOString(),
    });

    await sleep(400);

    const after = service.getBinding('demo-binding', { includeCode: true }) as Record<string, any>;
    assert.equal(after.metadata.fired, true);

    const mismatch = await service.rebind('demo-binding', { metadata: { fired: false } });
    assert.equal((mismatch.metadata as any)?.fired, false);

    await service.dispatchEvent({
      sensor: 'demo',
      event: 'ping',
      args: ['wrong'],
      payload: { value: 'ignored' },
      occurredAt: new Date().toISOString(),
    });

    await sleep(200);

    const unchanged = service.getBinding('demo-binding') as Record<string, any>;
    assert.equal(unchanged.metadata.fired, false);

    assert.deepEqual(service.unbind('demo-binding'), { ok: true });
    assert.equal(service.getBinding('demo-binding'), null);
  } finally {
    await service.stop();
    await rm(layout.root, { recursive: true, force: true });
  }
});

test('archives legacy tasks file on initialization', async () => {
  const layout = await createTempHeartbeatLayout();
  await writeStubSensor(layout.sensorsDir);
  await writeFile(path.join(layout.dataDir, 'tasks.json'), JSON.stringify([{ id: 'legacy' }]), 'utf-8');

  const service = new HeartbeatService({
    dataDir: layout.dataDir,
    sensorsDir: layout.sensorsDir,
  });

  try {
    await service.initialize({ enableWatcher: true });
    assert.equal(existsSync(path.join(layout.dataDir, 'tasks.json')), false);
    const files = await readdir(layout.dataDir);
    assert.ok(files.some(file => file.startsWith('tasks.legacy.')));
  } finally {
    await service.stop();
    await rm(layout.root, { recursive: true, force: true });
  }
});

test('fires clock schedule bindings on matching local weekday and time', async () => {
  const layout = await createTempHeartbeatLayout();
  await writeClockSensor(layout.sensorsDir);

  const service = new HeartbeatService({
    dataDir: layout.dataDir,
    sensorsDir: layout.sensorsDir,
  });

  try {
    await service.initialize({ enableWatcher: true });

    const schedule = {
      rules: [
        {
          days: ['wednesday'],
          times: ['09:00'],
        },
      ],
    };

    await service.bind(
      service.createEventRef('clock', 'schedule', [schedule]),
      async (event: any, ctx: any) => {
        await ctx.rebind({ metadata: { fired: true, schedule: event.payload?.schedule } });
      },
      { id: 'clock-schedule', metadata: { fired: false } }
    );

    const matchDate = new Date(2026, 0, 1, 9, 0, 0);
    while (matchDate.getDay() !== 3) {
      matchDate.setDate(matchDate.getDate() + 1);
    }
    matchDate.setHours(9, 0, 0, 0);
    await service.dispatchEvent({
      sensor: 'clock',
      event: 'schedule',
      args: [],
      payload: {
        iso: matchDate.toISOString(),
        localeTime: matchDate.toLocaleTimeString(),
        localeDate: matchDate.toLocaleDateString(),
        weekday: matchDate.toLocaleDateString('en-US', { weekday: 'long' }),
        hour: matchDate.getHours(),
        minute: matchDate.getMinutes(),
        second: matchDate.getSeconds(),
        timestamp: matchDate.getTime(),
      },
      occurredAt: matchDate.toISOString(),
    });

    const afterFire = JSON.parse(await readFile(path.join(layout.dataDir, 'bindings.json'), 'utf-8')) as Array<Record<string, any>>;
    const fired = afterFire.find(binding => binding.id === 'clock-schedule');
    assert.equal((fired?.metadata as any)?.fired, true);
    assert.deepEqual((fired as any)?.eventRef?.args, [schedule]);
    assert.deepEqual((fired?.metadata as any)?.schedule?.matchedRuleIndexes, [0]);
    assert.deepEqual((fired?.metadata as any)?.schedule?.matchedRules?.[0]?.days, ['wednesday']);

    await service.rebind('clock-schedule', { metadata: { fired: false } });

    const missDate = new Date(matchDate);
    missDate.setMinutes(5);
    await service.dispatchEvent({
      sensor: 'clock',
      event: 'schedule',
      args: [],
      payload: {
        iso: missDate.toISOString(),
        localeTime: missDate.toLocaleTimeString(),
        localeDate: missDate.toLocaleDateString(),
        weekday: missDate.toLocaleDateString('en-US', { weekday: 'long' }),
        hour: missDate.getHours(),
        minute: missDate.getMinutes(),
        second: missDate.getSeconds(),
        timestamp: missDate.getTime(),
      },
      occurredAt: missDate.toISOString(),
    });

    const afterMiss = JSON.parse(await readFile(path.join(layout.dataDir, 'bindings.json'), 'utf-8')) as Array<Record<string, any>>;
    const missBinding = afterMiss.find(binding => binding.id === 'clock-schedule');
    assert.equal((missBinding?.metadata as any)?.fired, false);
  } finally {
    await service.stop();
    await rm(layout.root, { recursive: true, force: true });
  }
});

test('fires clock every bindings for arbitrary compound intervals without duplicate executions per second', async () => {
  const layout = await createTempHeartbeatLayout();
  await writeClockSensor(layout.sensorsDir);

  const service = new HeartbeatService({
    dataDir: layout.dataDir,
    sensorsDir: layout.sensorsDir,
  });

  try {
    await service.initialize({ enableWatcher: false });

    await service.bind(
      service.createEventRef('clock', 'every', ['4h']),
      async (event: any, ctx: any) => {
        await ctx.rebind({
          metadata: {
            lastOccurredAt: event.occurredAt,
          },
        });
      },
      { id: 'clock-every-4h', metadata: {} }
    );

    await service.bind(
      service.createEventRef('clock', 'every', ['1h30m']),
      async (event: any, ctx: any) => {
        await ctx.rebind({
          metadata: {
            lastOccurredAt: event.occurredAt,
            interval: event.payload?.every?.interval,
            milliseconds: event.payload?.every?.milliseconds,
          },
        });
      },
      { id: 'clock-every-90m', metadata: {} }
    );

    const fourHourDate = new Date(2026, 0, 7, 4, 0, 0, 0);
    await service.dispatchEvent({
      sensor: 'clock',
      event: 'every',
      args: ['1s'],
      payload: {
        iso: fourHourDate.toISOString(),
        localeTime: fourHourDate.toLocaleTimeString(),
        localeDate: fourHourDate.toLocaleDateString(),
        weekday: fourHourDate.toLocaleDateString('en-US', { weekday: 'long' }),
        hour: fourHourDate.getHours(),
        minute: fourHourDate.getMinutes(),
        second: fourHourDate.getSeconds(),
        timestamp: fourHourDate.getTime(),
      },
      occurredAt: fourHourDate.toISOString(),
    });
    await sleep(400);

    const after4h = JSON.parse(await readFile(path.join(layout.dataDir, 'bindings.json'), 'utf-8')) as Array<Record<string, any>>;
    const binding4h = after4h.find(binding => binding.id === 'clock-every-4h');
    const binding90mAfter4h = after4h.find(binding => binding.id === 'clock-every-90m');
    assert.equal(binding4h?.metadata?.lastOccurredAt, fourHourDate.toISOString());
    assert.equal(binding90mAfter4h?.metadata?.lastOccurredAt, undefined);

    const ninetyMinuteDate = new Date(2026, 0, 7, 4, 30, 0, 0);
    const ninetyMinutePayload = {
      iso: ninetyMinuteDate.toISOString(),
      localeTime: ninetyMinuteDate.toLocaleTimeString(),
      localeDate: ninetyMinuteDate.toLocaleDateString(),
      weekday: ninetyMinuteDate.toLocaleDateString('en-US', { weekday: 'long' }),
      hour: ninetyMinuteDate.getHours(),
      minute: ninetyMinuteDate.getMinutes(),
      second: ninetyMinuteDate.getSeconds(),
      timestamp: ninetyMinuteDate.getTime(),
    };

    await service.dispatchEvent({
      sensor: 'clock',
      event: 'every',
      args: ['1s'],
      payload: ninetyMinutePayload,
      occurredAt: ninetyMinuteDate.toISOString(),
    });

    await service.dispatchEvent({
      sensor: 'clock',
      event: 'every',
      args: ['5m'],
      payload: ninetyMinutePayload,
      occurredAt: ninetyMinuteDate.toISOString(),
    });
    await sleep(400);

    const after90m = JSON.parse(await readFile(path.join(layout.dataDir, 'bindings.json'), 'utf-8')) as Array<Record<string, any>>;
    const binding90m = after90m.find(binding => binding.id === 'clock-every-90m');
    const binding4hAfter90m = after90m.find(binding => binding.id === 'clock-every-4h');
    assert.equal(binding90m?.metadata?.lastOccurredAt, ninetyMinuteDate.toISOString());
    assert.equal(binding90m?.metadata?.interval, '1h30m');
    assert.equal(binding90m?.metadata?.milliseconds, 5_400_000);
    assert.equal(binding4hAfter90m?.metadata?.lastOccurredAt, fourHourDate.toISOString());

    const secondNinetyMinuteDate = new Date(2026, 0, 7, 6, 0, 0, 0);
    await service.dispatchEvent({
      sensor: 'clock',
      event: 'every',
      args: ['1s'],
      payload: {
        iso: secondNinetyMinuteDate.toISOString(),
        localeTime: secondNinetyMinuteDate.toLocaleTimeString(),
        localeDate: secondNinetyMinuteDate.toLocaleDateString(),
        weekday: secondNinetyMinuteDate.toLocaleDateString('en-US', { weekday: 'long' }),
        hour: secondNinetyMinuteDate.getHours(),
        minute: secondNinetyMinuteDate.getMinutes(),
        second: secondNinetyMinuteDate.getSeconds(),
        timestamp: secondNinetyMinuteDate.getTime(),
      },
      occurredAt: secondNinetyMinuteDate.toISOString(),
    });
    await sleep(400);

    const afterSecond90m = JSON.parse(await readFile(path.join(layout.dataDir, 'bindings.json'), 'utf-8')) as Array<Record<string, any>>;
    const updated90m = afterSecond90m.find(binding => binding.id === 'clock-every-90m');
    assert.equal(updated90m?.metadata?.lastOccurredAt, secondNinetyMinuteDate.toISOString());
  } finally {
    await service.stop();
    await rm(layout.root, { recursive: true, force: true });
  }
});
