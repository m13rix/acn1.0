const MEMORY_INGEST_DISABLED = '1';

export function isMemoryIngestAllowed(): boolean {
  return process.env.TELOS_MEMORY_INGEST_DISABLED !== MEMORY_INGEST_DISABLED;
}

export function assertMemoryIngestAllowed(): void {
  if (!isMemoryIngestAllowed()) {
    throw new Error(
      'Memory ingestion is temporarily disabled in this process. Unset TELOS_MEMORY_INGEST_DISABLED to re-enable it.',
    );
  }
}
