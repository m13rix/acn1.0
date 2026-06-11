import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const IMPORTED_TOOLS_ROOT = process.env['TELOS_IMPORTED_TOOLS_ROOT']
  || join(__dirname, '..', '..');
export const IMPORTED_TOOLS_DATA_DIR = join(IMPORTED_TOOLS_ROOT, 'data', 'imported-tools');
export const IMPORTED_TOOLS_RUNTIME_DIR = join(IMPORTED_TOOLS_DATA_DIR, 'runtime');
export const IMPORTED_TOOLS_TOOLS_DIR = join(IMPORTED_TOOLS_ROOT, 'tools');
export const IMPORTED_TOOLS_MCP_DIR = join(IMPORTED_TOOLS_TOOLS_DIR, 'mcp');
export const IMPORTED_TOOLS_CLAWHUB_DIR = join(IMPORTED_TOOLS_TOOLS_DIR, 'clawhub');
export const IMPORTED_TOOLS_STAGING_DIR = join(IMPORTED_TOOLS_DATA_DIR, 'staging');
export const IMPORTED_TOOLS_DEFAULT_GEMINI_MODEL =
  process.env['IMPORTED_TOOLS_GEMINI_MODEL'] || 'gemini-3.1-flash-lite-preview';
export const IMPORTED_TOOLS_DOCS_MODE =
  process.env['IMPORTED_TOOLS_DOCS_MODE'] || process.env['NODE_ENV'] || 'production';
export const IMPORTED_TOOLS_GEMINI_TIMEOUT_MS = Number(
  process.env['IMPORTED_TOOLS_GEMINI_TIMEOUT_MS'] || 15000
);
export const IMPORTED_TOOLS_MCP_TIMEOUT_MS = Number(
  process.env['IMPORTED_TOOLS_MCP_TIMEOUT_MS'] || 20000
);
export const IMPORTED_TOOLS_MCP_CALL_TIMEOUT_MS = Number(
  process.env['IMPORTED_TOOLS_MCP_CALL_TIMEOUT_MS'] || 30000
);

export const IMPORTED_RUNTIME_MODULE_PATH = '../../../src/imported-tools/runtime.js';
export const IMPORTED_MANIFEST_FILENAME = 'import.manifest.json';
export const IMPORTED_LOCK_FILENAME = 'install.lock.json';
