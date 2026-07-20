import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { v7 as uuidv7 } from 'uuid';

import { parseWindowsNetstat, ProjectScriptService } from './ProjectScriptService.js';
import { ThreadStore } from './thread-store/ThreadStore.js';
import type { StoredTerminalSession } from './thread-store/types.js';
import type { TerminalService } from './TerminalService.js';

test('saves and starts a project script in a thread-owned terminal', async () => {
  const directory = join(tmpdir(), `telos-project-script-${uuidv7()}`);
  await mkdir(directory, { recursive: true });
  const store = await ThreadStore.open({ databasePath: join(directory, 'threads.db') });
  const opened: Array<Record<string, unknown>> = [];
  const terminal: StoredTerminalSession = {
    id: uuidv7(), threadId: '', cwd: directory, command: '', status: 'running', history: '', cols: 120,
    rows: 30, pid: 42, exitCode: null, exitSignal: null, label: 'Dev', sequence: 0,
    hasRunningSubprocess: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const terminals = {
    open: async (input: Record<string, unknown>) => {
      opened.push(input);
      return { ...terminal, id: String(input.terminalId), threadId: String(input.threadId), command: String(input.command) };
    },
  } as unknown as TerminalService;
  try {
    const project = store.createProject({ path: directory });
    const thread = store.createThread({
      launchProfile: {
        projectId: project.id as never, workspacePath: directory, worktreePath: null, agentName: 'Code',
        resolvedAgentConfig: {}, providerId: 'provider', modelId: 'model', reasoning: 'high',
      },
    });
    const service = new ProjectScriptService(store, terminals);
    const script = service.save({
      projectId: project.id,
      name: 'Dev server',
      command: 'npm run dev',
      previewUrl: 'http://127.0.0.1:5173',
      autoOpenPreview: true,
    });
    const terminalId = uuidv7();
    const started = await service.start({ threadId: thread.id, scriptId: script.id, terminalId });

    assert.equal(started.script.autoOpenPreview, true);
    assert.equal(started.terminal.id, terminalId);
    assert.deepEqual(opened, [{
      threadId: thread.id,
      terminalId,
      command: 'npm run dev',
      keepOpen: true,
    }]);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('maps Windows listeners from terminal process trees to preview URLs', () => {
  const terminal = {
    id: 'terminal-1',
  } as StoredTerminalSession;
  const ports = parseWindowsNetstat([
    '  TCP    0.0.0.0:5173       0.0.0.0:0       LISTENING       222',
    '  TCP    127.0.0.1:3000     0.0.0.0:0       LISTENING       999',
  ].join('\r\n'), new Map([[222, terminal]]));

  assert.deepEqual(ports, [{
    port: 5173,
    host: '127.0.0.1',
    protocol: 'http',
    processId: 222,
    terminalId: 'terminal-1',
    url: 'http://127.0.0.1:5173',
  }]);
});
