import 'dotenv/config';
import { FastMemoryIndex } from '../src/memory_system/FastMemoryIndex.js';

const table = process.env.MEMORY_TABLE || 'global_memory_v2';
const startedAt = Date.now();
const index = new FastMemoryIndex(table);

console.log(`[memory.fast-index] Building native vector index for ${table}...`);
await index.build((message) => console.log(`[memory.fast-index] ${message}`));
console.log(`[memory.fast-index] Complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
