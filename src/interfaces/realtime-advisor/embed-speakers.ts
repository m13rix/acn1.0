import { config as loadDotenv } from 'dotenv';
import path from 'path';
import { existsSync } from 'fs';
import { RealtimeAdvisorStore } from './store.js';
import {
  EcapaEmbeddingService,
  writeEcapaEmbeddingFile,
  type EcapaEmbeddingSettings,
} from './ecapa.js';

loadDotenv();

function readBooleanEnv(name: string, fallback = false): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function readNumberEnv(name: string, fallback: number): number {
  const raw = (process.env[name] || '').trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseArgs(): { dataDir: string; force: boolean; settings: EcapaEmbeddingSettings } {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const dataDir = getArg('--data-dir')
    || process.env.TELOS_REALTIME_ADVISOR_DATA_DIR
    || path.resolve(process.cwd(), 'data', 'realtime-advisor');

  return {
    dataDir,
    force: args.includes('--force'),
    settings: {
      pythonPath: getArg('--python') || process.env.TELOS_REALTIME_ECAPA_PYTHON || process.env.PYTHON || 'python',
      modelCache: getArg('--model-cache')
        || process.env.TELOS_REALTIME_ECAPA_MODEL_CACHE
        || path.resolve(process.cwd(), 'models', 'speechbrain-spkrec-ecapa-voxceleb'),
      sampleRate: Math.max(1, Math.floor(readNumberEnv('TELOS_REALTIME_ECAPA_SAMPLE_RATE', 16000))),
      batchSize: Math.max(1, Math.floor(readNumberEnv('TELOS_REALTIME_ECAPA_BATCH_SIZE', 32))),
      chunkSeconds: Math.max(0, readNumberEnv('TELOS_REALTIME_ECAPA_CHUNK_SECONDS', 0)),
      overlapSeconds: Math.max(0, readNumberEnv('TELOS_REALTIME_ECAPA_OVERLAP_SECONDS', 0)),
      fp16: readBooleanEnv('TELOS_REALTIME_ECAPA_FP16', false),
      device: process.env.TELOS_REALTIME_ECAPA_DEVICE || 'cuda:0',
    },
  };
}

async function main(): Promise<void> {
  const { dataDir, force, settings } = parseArgs();
  const store = new RealtimeAdvisorStore(dataDir);
  await store.initialize();

  const speakers = store.listSpeakers()
    .filter((speaker) => speaker.samplePath && existsSync(speaker.samplePath))
    .filter((speaker) => force || !speaker.embeddingPath || !existsSync(speaker.embeddingPath));

  if (speakers.length === 0) {
    console.log('All realtime-advisor speakers already have ECAPA embeddings.');
    return;
  }

  const ecapa = new EcapaEmbeddingService(settings);
  try {
    await ecapa.warmup();
    const results = await ecapa.embedFiles(speakers.map((speaker) => speaker.samplePath));
    const resultByPath = new Map(results.map((result) => [path.resolve(result.path).toLowerCase(), result]));

    for (const speaker of speakers) {
      const result = resultByPath.get(path.resolve(speaker.samplePath).toLowerCase());
      if (!result) {
        console.warn(`No embedding returned for ${speaker.name} (${speaker.samplePath})`);
        continue;
      }
      const embeddingPath = store.getSpeakerEmbeddingPathForName(speaker.name);
      await writeEcapaEmbeddingFile(embeddingPath, result, speaker.samplePath);
      await store.updateSpeakerEmbedding({
        speakerId: speaker.id,
        embeddingPath,
        embeddingModel: result.model,
      });
      console.log(`Embedded ${speaker.name}: ${embeddingPath}`);
    }
  } finally {
    await ecapa.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
