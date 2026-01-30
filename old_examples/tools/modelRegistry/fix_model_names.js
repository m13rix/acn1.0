#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MODELS_JSON_PATH = path.join(PROJECT_ROOT, 'data/models/models.json');

const toSingleLine = (value) => (value || '').replace(/\s+/g, ' ').trim();

function removeTrailingDuplicate(value) {
  if (!value) return value;
  const str = value;
  for (let len = Math.floor(str.length / 2); len >= 1; len--) {
    const start = str.length - len * 2;
    if (start < 0) continue;
    const first = str.slice(start, str.length - len);
    const second = str.slice(str.length - len);
    if (first === second) {
      return str.slice(0, str.length - len);
    }
  }
  return str;
}

function cleanName(name) {
  const single = toSingleLine(name);
  const cleaned = removeTrailingDuplicate(single);
  if (cleaned.includes(':')) {
    const [prefix, ...restParts] = cleaned.split(':');
    const rest = restParts.join(':').trim();
    const dedupRest = removeTrailingDuplicate(rest);
    return `${prefix.trim()}: ${dedupRest}`.trim();
  }
  return cleaned;
}

async function main() {
  console.log(chalk.cyan('🧹 Исправление дублированных имён моделей...'));

  let data;
  try {
    const raw = await fs.readFile(MODELS_JSON_PATH, 'utf8');
    data = JSON.parse(raw);
  } catch (error) {
    console.error(chalk.red('Не удалось прочитать models.json:'), error.message);
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error(chalk.red('models.json имеет неожиданный формат (ожидался массив).'));
    process.exit(1);
  }

  let changes = 0;
  const updated = data.map((model) => {
    if (!model || typeof model !== 'object') return model;
    const originalName = model.name;
    const cleanedName = cleanName(originalName);
    if (cleanedName && cleanedName !== originalName) {
      changes += 1;
      return {
        ...model,
        name: cleanedName
      };
    }
    return model;
  });

  if (changes === 0) {
    console.log(chalk.yellow('Изменений не требуется – имена уже в порядке.'));
    return;
  }

  try {
    await fs.writeFile(MODELS_JSON_PATH, JSON.stringify(updated, null, 2), 'utf8');
    console.log(chalk.green(`✅ Обновлено моделей: ${changes}`));
  } catch (error) {
    console.error(chalk.red('Не удалось сохранить обновлённый models.json:'), error.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(chalk.red('Необработанная ошибка:'), error);
  process.exit(1);
});


