import 'dotenv/config';
import * as lancedb from '@lancedb/lancedb';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';

const namespace = String(process.env.MEMORY_TABLE || 'global_memory_v2').replace(/[^a-zA-Z0-9_]/g, '_');
const dataDir = path.resolve('data', 'memory');
const outputDir = path.join(dataDir, `${namespace}_fast_matrix_v1`);
const dimensions = 4096;
const db = await lancedb.connect(dataDir);
const facts = await db.openTable(`${namespace}_fast_v1_facts`);
const globals = await db.openTable(`${namespace}_fast_v1_globals`);
const phrases = await db.openTable(`${namespace}_fast_v1_phrases`);

await mkdir(outputDir, { recursive: true });
const factRows = await facts.query().select(['id', 'category']).toArray() as Array<Record<string, unknown>>;
const factIds = factRows.map((row) => String(row.id));
const factCategories = factRows.map((row) => String(row.category || ''));
const factIndex = new Map(factIds.map((id, index) => [id, index]));

function vectorBuffer(raw: unknown): Buffer | null {
  if (!raw || typeof raw !== 'object' || typeof (raw as ArrayLike<number>).length !== 'number') return null;
  const values = Array.from(raw as ArrayLike<number>, Number);
  if (values.length !== dimensions) return null;
  const buffer = Buffer.allocUnsafe(dimensions * 4);
  for (let index = 0; index < dimensions; index++) buffer.writeFloatLE(Number(values[index]) || 0, index * 4);
  return buffer;
}

async function exportRows(input: {
  table: lancedb.Table;
  columns: string[];
  prefix: string;
  accept?: (row: Record<string, unknown>) => boolean;
}): Promise<number> {
  const matrix = await open(path.join(outputDir, `${input.prefix}.f32`), 'w');
  const indices: number[] = [];
  let count = 0;
  try {
    for await (const batch of input.table.query().select(input.columns)) {
      for (const row of batch.toArray() as Array<Record<string, unknown>>) {
        if (input.accept && !input.accept(row)) continue;
        const index = factIndex.get(String(row.factId || ''));
        const buffer = vectorBuffer(row.vector);
        if (index === undefined || !buffer) continue;
        await matrix.write(buffer);
        indices.push(index);
        count += 1;
      }
    }
  } finally {
    await matrix.close();
  }
  const indexBuffer = Buffer.allocUnsafe(indices.length * 4);
  indices.forEach((value, index) => indexBuffer.writeInt32LE(value, index * 4));
  await writeFile(path.join(outputDir, `${input.prefix}.fact_i32`), indexBuffer);
  return count;
}

console.log(`[memory.fast-matrix] Exporting ${factIds.length} facts...`);
const globalCount = await exportRows({ table: globals, columns: ['factId', 'vector'], prefix: 'globals' });
const phraseCounts: Record<string, number> = {};
for (const type of ['np', 'vp', 'adjp']) {
  phraseCounts[type] = await exportRows({
    table: phrases,
    columns: ['factId', 'type', 'vector'],
    prefix: `phrases_${type}`,
    accept: (row) => row.type === type,
  });
  console.log(`[memory.fast-matrix] ${type}: ${phraseCounts[type]} vectors`);
}
await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify({
  version: 1,
  namespace,
  dimensions,
  factIds,
  factCategories,
  factCount: factIds.length,
  globalCount,
  phraseCounts,
  sourceCounts: {
    facts: await (await db.openTable(`${namespace}_facts`)).countRows(),
    hints: await (await db.openTable(`${namespace}_hints`)).countRows(),
    links: await (await db.openTable(`${namespace}_links`)).countRows(),
  },
  builtAt: Date.now(),
}, null, 2));
console.log(`[memory.fast-matrix] Ready: ${globalCount} global and ${Object.values(phraseCounts).reduce((a, b) => a + b, 0)} phrase vectors.`);
