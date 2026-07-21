import 'dotenv/config';
import { getContentMemoryService, type StoredContentRow } from '../src/content_memory/service.js';

const service = getContentMemoryService();
const rows = (await service.rows()).filter((row) => row.kind === 'text' && row.text.trim().split(/\s+/u).filter(Boolean).length > 30);
const concurrency = Math.max(1, Number(process.env.CONTENT_SENTENCE_INDEX_CONCURRENCY || 4));
let cursor = 0;
let completed = 0;
let sentenceCount = 0;
const failures: Array<{ id: string; error: string }> = [];

async function worker(): Promise<void> {
  for (;;) {
    const index = cursor++;
    const row: StoredContentRow | undefined = rows[index];
    if (!row) return;
    try {
      const sentences = await service.getOrCreateSentenceEmbeddings(row);
      sentenceCount += sentences.length;
    } catch (error) {
      failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
    }
    completed += 1;
    console.log(`[content.sentences] ${completed}/${rows.length} rows, ${sentenceCount} sentences, ${failures.length} failures`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
if (failures.length > 0) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  console.log(`[content.sentences] Complete: ${rows.length} long rows and ${sentenceCount} cached sentences.`);
}
