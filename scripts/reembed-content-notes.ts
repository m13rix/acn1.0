import 'dotenv/config';
import { getContentMemoryService } from '../src/content_memory/service.js';

const model = process.env.MEMORY_NOTES_EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b';
const result = await getContentMemoryService().reembedCollection('notes', model, (completed, total, row) => {
  if (completed === 1 || completed % 10 === 0 || completed === total) {
    console.log(`[notes-reindex] ${completed}/${total} ${row.originalName || row.id}`);
  }
});
console.log(JSON.stringify(result));
