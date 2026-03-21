import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { createServer } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = join(tmpdir(), 'acn-imported-tools-tests');
const FIXTURE_DIR = join(__dirname, '..', '__fixtures__');
const FIXTURE_SERVER = join(FIXTURE_DIR, 'fake-mcp-server.js');

process.env.ACN_IMPORTED_TOOLS_ROOT = TEST_ROOT;
process.env.IMPORTED_TOOLS_DOCS_MODE = 'test';
process.env.IMPORTED_TOOLS_SKIP_GEMINI = '1';

async function startApp() {
  const { createImportedToolsStudioApp } = await import('../../imported-tools-studio/server/app.js');
  const app = createImportedToolsStudioApp();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server.');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function request<T = any>(baseUrl: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json() as T;
  return { response, payload };
}

test('API flow inspects, applies, lists, and deletes an MCP import', async () => {
  await mkdir(join(TEST_ROOT, 'tools', 'mcp'), { recursive: true });
  await mkdir(join(TEST_ROOT, 'tools', 'clawhub'), { recursive: true });
  await mkdir(join(TEST_ROOT, 'data', 'imported-tools'), { recursive: true });

  const { server, baseUrl } = await startApp();
  try {
    const inspectPayload = {
      kind: 'mcp',
      source: {
        type: 'localPath',
        value: FIXTURE_DIR,
        displayName: 'SdamGIA',
        command: process.execPath,
        args: [FIXTURE_SERVER],
      },
      docs: [{ name: 'notes.md', content: 'Prefer compact ACN docs.' }],
    };

    const inspected = await request(baseUrl, '/api/imports/inspect', {
      method: 'POST',
      body: JSON.stringify(inspectPayload),
    });
    assert.equal(inspected.response.status, 200);
    assert.equal(inspected.payload.draft.namespace, 'sdamgia');
    assert.equal(inspected.payload.draft.methods.length, 1);

    const applied = await request(baseUrl, '/api/imports/apply', {
      method: 'POST',
      body: JSON.stringify({ draft: inspected.payload.draft }),
    });
    assert.equal(applied.response.status, 201);
    assert.equal(applied.payload.import.smokeTest.passed, true);

    const listed = await request(baseUrl, '/api/imports');
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.imports.length, 1);

    const deleted = await request(baseUrl, `/api/imports/${encodeURIComponent(applied.payload.import.id)}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.response.status, 200);

    const empty = await request(baseUrl, '/api/imports');
    assert.equal(empty.payload.imports.length, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(TEST_ROOT, { recursive: true, force: true });
  }
});
