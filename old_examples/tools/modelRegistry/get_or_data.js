#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');

const MODELS_JSON_PATH = path.join(PROJECT_ROOT, 'data/models/models.json');
const TARGET_URL = 'https://openrouter.ai/models?order=top-weekly';

const ANCHOR_SELECTOR = 'a.transition-colors.text-secondary-foreground';
const CARD_HEIGHT_PX = 208;
const PROVIDER = 'openrouter';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function scrapeModels() {
  console.log(chalk.yellow('[STUB] scrapeModels called, but puppeteer is removed.'));
  return [];
}

async function main() {
  console.log(chalk.cyan('▶️  Запуск скрэпера OpenRouter Top Weekly (ЗАГЛУШКА)…'));
  console.log(chalk.yellow('Этот инструмент временно отключен, так как puppeteer удален из проекта.'));
}

main().catch((error) => {
  console.error(chalk.red('❌ Ошибка при выполнении скрэпера:'), error);
  process.exit(1);
});


