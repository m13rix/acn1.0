import 'dotenv/config';
import { getContentMemoryService } from '../src/content_memory/service.js';

const model = process.env.MEMORY_CONVERSATION_TEXT_EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b';
const service = getContentMemoryService();
const result = await service.reembedCollection('conversation_transcripts', model, (completed, total, row) => {
  if (completed === 1 || completed % 10 === 0 || completed === total) {
    console.log(`[conversation-reindex] ${completed}/${total} ${row.id}`);
  }
});

console.log(JSON.stringify(result));
