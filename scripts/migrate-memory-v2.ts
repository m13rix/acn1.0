import { MemoryService } from '../src/memory_system/MemoryService.js';
import { DEFAULT_MEMORY_CONFIG } from '../src/memory_system/types.js';

async function main(): Promise<void> {
  const sourceNamespace = process.argv[2] || 'global_memory';
  const targetNamespace = process.argv[3] || process.env.MEMORY_TABLE || DEFAULT_MEMORY_CONFIG.table;

  const service = new MemoryService({
    table: targetNamespace,
  });
  await service.initialize();

  const result = await service.migrateLegacyNamespace(sourceNamespace);
  console.log(JSON.stringify({
    sourceNamespace,
    targetNamespace,
    ...result,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
