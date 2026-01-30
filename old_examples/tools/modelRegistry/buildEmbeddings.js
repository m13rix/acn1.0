#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';
import { embedTextBatch } from '../../src/utils/embeddingService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const MODELS_PATH = path.join(projectRoot, 'data/models/models.json');
const EMBEDDINGS_PATH = path.join(projectRoot, 'data/models/embeddings.json');

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function parseArgs() {
  const force = process.argv.includes('--force');
  return { force };
}

async function main() {
  const { force } = parseArgs();

  console.log(chalk.cyan('📚 Loading model registry...'));
  const models = await readJson(MODELS_PATH, []);
  if (!Array.isArray(models) || models.length === 0) {
    console.log(chalk.red('Model registry is empty. Nothing to embed.'));
    process.exit(1);
  }

  const existingEmbeddings = await readJson(EMBEDDINGS_PATH, {});
  const pending = [];

  for (const model of models) {
    const id = model.id || model.name;
    if (!id) {
      console.log(chalk.yellow('Skipping model without id:'), model);
      continue;
    }

    if (!force && Array.isArray(existingEmbeddings[id])) {
      continue;
    }

    if (!model.description) {
      console.log(chalk.yellow(`Skipping model "${id}" without description.`));
      continue;
    }

    pending.push({
      id,
      description: model.description
    });
  }

  if (pending.length === 0) {
    console.log(chalk.green('All model descriptions already have embeddings.'));
    process.exit(0);
  }

  console.log(chalk.cyan(`🔄 Computing embeddings for ${pending.length} model(s)...`));

  const descriptions = pending.map(item => item.description);
  const vectors = await embedTextBatch(descriptions);

  pending.forEach((item, index) => {
    existingEmbeddings[item.id] = vectors[index];
  });

  await writeJson(EMBEDDINGS_PATH, existingEmbeddings);
  console.log(chalk.green('✅ Embeddings updated successfully.'));
}

main().catch(error => {
  console.error(chalk.red('❌ Failed to build embeddings:'), error.message);
  process.exit(1);
});


