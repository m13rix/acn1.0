import { Codex } from '@openai/codex-sdk';
import { existsSync } from 'fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'codex');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');
const STREAMS_DIR = path.join(DATA_DIR, 'streams');

function nowIso() {
  return new Date().toISOString();
}

function getStreamStatePath(threadId) {
  return path.join(STREAMS_DIR, `${threadId}.json`);
}

function getStreamRequestPath(threadId) {
  return path.join(STREAMS_DIR, `${threadId}.request.json`);
}

async function ensureStorage() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(STREAMS_DIR, { recursive: true });

  if (!existsSync(THREADS_FILE)) {
    await writeJsonAtomic(THREADS_FILE, []);
  }
}

async function readJsonFile(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tempPath, filePath);
}

async function loadThreadRecords() {
  await ensureStorage();
  const records = await readJsonFile(THREADS_FILE, []);
  return Array.isArray(records) ? records : [];
}

async function saveThreadRecords(records) {
  await writeJsonAtomic(THREADS_FILE, records);
}

async function findThreadRecord(id) {
  const records = await loadThreadRecords();
  return records.find(record => record.id === id || record.sdkThreadId === id) || null;
}

async function upsertThreadRecord(updatedRecord) {
  const records = await loadThreadRecords();
  const index = records.findIndex(record => record.id === updatedRecord.id);

  if (index >= 0) {
    records[index] = updatedRecord;
  } else {
    records.push(updatedRecord);
  }

  await saveThreadRecords(records);
}

async function writeStatus(threadId, updater) {
  const statePath = getStreamStatePath(threadId);
  const current = await readJsonFile(statePath, null);

  if (!current) {
    throw new Error(`Stream state for thread "${threadId}" was not initialized`);
  }

  const next = updater({ ...current, items: Array.isArray(current.items) ? [...current.items] : [] });
  next.updatedAt = nowIso();
  await writeJsonAtomic(statePath, next);
}

async function main() {
  const managedThreadId = process.argv[2];
  if (!managedThreadId) {
    throw new Error('Missing managed thread id argument');
  }

  const record = await findThreadRecord(managedThreadId);
  if (!record) {
    throw new Error(`Codex thread "${managedThreadId}" was not found in the managed registry`);
  }

  const requestPath = getStreamRequestPath(record.id);
  const request = await readJsonFile(requestPath, null);
  if (!request) {
    throw new Error(`Stream request payload was not found for thread "${record.id}"`);
  }

  await writeStatus(record.id, status => ({
    ...status,
    sdkThreadId: record.sdkThreadId || null,
  }));

  const client = new Codex();
  const thread = record.sdkThreadId
    ? client.resumeThread(record.sdkThreadId, record.options)
    : client.startThread(record.options);

  let completed = false;

  try {
    const { events } = await thread.runStreamed(request.input, request.turnOptions);

    for await (const event of events) {
      if (event.type === 'thread.started') {
        if (thread.id && thread.id !== record.sdkThreadId) {
          record.sdkThreadId = thread.id;
          record.updatedAt = nowIso();
          await upsertThreadRecord(record);
        }

        await writeStatus(record.id, status => ({
          ...status,
          sdkThreadId: thread.id || status.sdkThreadId || null,
        }));
        continue;
      }

      if (event.type === 'item.completed') {
        await writeStatus(record.id, status => {
          status.items.push(event.item);
          if (event.item.type === 'agent_message') {
            status.finalResponse = event.item.text;
          }
          return status;
        });
        continue;
      }

      if (event.type === 'turn.completed') {
        completed = true;
        await writeStatus(record.id, status => ({
          ...status,
          completed: true,
          usage: event.usage,
          sdkThreadId: thread.id || status.sdkThreadId || null,
        }));
        continue;
      }

      if (event.type === 'turn.failed') {
        completed = true;
        await writeStatus(record.id, status => ({
          ...status,
          completed: true,
          error: event.error?.message || 'Codex turn failed',
          sdkThreadId: thread.id || status.sdkThreadId || null,
        }));
        continue;
      }

      if (event.type === 'error') {
        completed = true;
        await writeStatus(record.id, status => ({
          ...status,
          completed: true,
          error: event.message || 'Codex stream emitted an error event',
          sdkThreadId: thread.id || status.sdkThreadId || null,
        }));
      }
    }

    if (!completed) {
      await writeStatus(record.id, status => ({
        ...status,
        completed: true,
        sdkThreadId: thread.id || status.sdkThreadId || null,
      }));
    }
  } catch (error) {
    completed = true;
    await writeStatus(record.id, status => ({
      ...status,
      completed: true,
      error: error instanceof Error ? error.message : String(error),
      sdkThreadId: thread.id || status.sdkThreadId || null,
    }));
  } finally {
    try {
      await unlink(requestPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

await main();
