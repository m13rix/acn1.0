/**
 * Миграция: пересчитать totalCreditsUsd для всех пользователей.
 *
 * Цель: привести "пул кредитов" к формуле:
 *   baseCreditsUsd = rubToUsd(priceRub * (1 - profitShare), fxRate)
 *   totalCreditsUsd = baseCreditsUsd + period.topUpUsdTotal
 *
 * Важно:
 * - Мы НЕ можем корректно пересчитать топапы в RUB (их суммы/FX/профит не хранятся),
 *   поэтому сохраняем USD-сумму топапов как есть: period.topUpUsdTotal.
 *
 * Запуск:
 *   node scripts/fixSubscriptionCredits.js            # dry-run (ничего не пишет)
 *   node scripts/fixSubscriptionCredits.js --apply    # применить изменения
 *   node scripts/fixSubscriptionCredits.js --user <USER_ID>
 *
 * Опционально:
 *   --epsilon <number>  (по умолчанию 1e-9) - порог изменения
 */

import 'dotenv/config';
import { listObjects, loadJson, saveJson } from '../src/server/s3Storage.js';
import { getRubToUsdRate, rubToUsd } from '../src/server/currencyService.js';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function normalizeKey(key) {
  return String(key || '').replace(/\\/g, '/');
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

async function listSubscriptionJsonKeys() {
  const rootPrefix = 'billing/subscriptions/';
  const rootKeysRaw = await listObjects(rootPrefix);
  const rootKeys = rootKeysRaw.map(normalizeKey);

  // S3 case: обычно вернет ВСЕ объекты под префиксом, включая subscription.json
  const direct = rootKeys.filter((k) => k.endsWith('/subscription.json'));
  if (direct.length > 0) return [...new Set(direct)];

  // Local fallback case: listObjects(rootPrefix) часто вернет список userId-директорий.
  const out = [];
  for (const maybeUserPrefix of rootKeys) {
    const p = maybeUserPrefix.endsWith('/') ? maybeUserPrefix : `${maybeUserPrefix}/`;
    const innerRaw = await listObjects(p);
    const inner = innerRaw.map(normalizeKey);
    for (const k of inner) {
      if (k.endsWith('/subscription.json')) out.push(k);
    }
  }
  return [...new Set(out)];
}

function formatUsd(x) {
  const n = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(n)) return String(x);
  return n.toFixed(6);
}

async function main() {
  const apply = hasArg('--apply');
  const userFilter = argValue('--user');
  const epsilonRaw = argValue('--epsilon');
  const epsilon = epsilonRaw ? Number(epsilonRaw) : 1e-9;

  if (!Number.isFinite(epsilon) || epsilon < 0) {
    console.error(`[fixCredits] Invalid --epsilon: ${epsilonRaw}`);
    process.exitCode = 2;
    return;
  }

  const keys = await listSubscriptionJsonKeys();
  const filteredKeys = userFilter
    ? keys.filter((k) => k.includes(`/billing/subscriptions/${userFilter}/`) || k.endsWith(`/billing/subscriptions/${userFilter}/subscription.json`))
    : keys;

  if (filteredKeys.length === 0) {
    console.log('[fixCredits] No subscription.json found under billing/subscriptions/.');
    return;
  }

  // Если FX отсутствует в подписке, возьмем "живой" курс один раз для всех.
  let liveRate = null;

  let scanned = 0;
  let changed = 0;
  let skipped = 0;

  console.log(`[fixCredits] Found ${filteredKeys.length} subscription(s). Mode: ${apply ? 'APPLY' : 'DRY-RUN'}. Epsilon: ${epsilon}`);

  for (const key of filteredKeys) {
    scanned += 1;

    const sub = await loadJson(key);
    if (!sub) {
      skipped += 1;
      console.warn(`[fixCredits] Skip (missing): ${key}`);
      continue;
    }

    const priceRub = typeof sub.priceRub === 'number' ? sub.priceRub : Number(sub.priceRub);
    if (!Number.isFinite(priceRub) || priceRub <= 0) {
      skipped += 1;
      console.warn(`[fixCredits] Skip (invalid priceRub=${sub.priceRub}): ${key}`);
      continue;
    }

    const ps = isFiniteNumber(sub.profitShare) ? sub.profitShare : Number(sub.profitShare);
    const profitShare = Number.isFinite(ps) ? ps : 0.7;
    if (profitShare < 0 || profitShare >= 1) {
      skipped += 1;
      console.warn(`[fixCredits] Skip (invalid profitShare=${sub.profitShare}): ${key}`);
      continue;
    }

    let rate = sub?.fx?.rateRubToUsd;
    rate = typeof rate === 'number' ? rate : Number(rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      if (!liveRate) {
        const { rate: r } = await getRubToUsdRate();
        liveRate = r;
      }
      rate = liveRate;
    }

    const baseRub = priceRub * (1 - profitShare);
    const baseUsd = rubToUsd(baseRub, rate);

    const topUpUsdTotalRaw = sub?.period?.topUpUsdTotal;
    const topUpUsdTotal = typeof topUpUsdTotalRaw === 'number' ? topUpUsdTotalRaw : Number(topUpUsdTotalRaw);
    const safeTopUpUsdTotal = Number.isFinite(topUpUsdTotal) && topUpUsdTotal > 0 ? topUpUsdTotal : 0;

    const expectedTotalCreditsUsd = baseUsd + safeTopUpUsdTotal;

    const oldTotalCreditsUsdRaw = sub.totalCreditsUsd;
    const oldTotalCreditsUsd = typeof oldTotalCreditsUsdRaw === 'number' ? oldTotalCreditsUsdRaw : Number(oldTotalCreditsUsdRaw);
    const old = Number.isFinite(oldTotalCreditsUsd) ? oldTotalCreditsUsd : 0;

    const delta = expectedTotalCreditsUsd - old;
    if (Math.abs(delta) <= epsilon) continue;

    const spent = Number(sub?.period?.totalSpentUsd || 0);
    console.log(
      `[fixCredits] ${apply ? 'UPDATE' : 'WOULD_UPDATE'} ${key}\n` +
        `  old totalCreditsUsd: ${formatUsd(old)}\n` +
        `  new totalCreditsUsd: ${formatUsd(expectedTotalCreditsUsd)} (base=${formatUsd(baseUsd)} topUp=${formatUsd(safeTopUpUsdTotal)})\n` +
        `  spent: ${formatUsd(spent)}; remaining(old)=${formatUsd(old - spent)} remaining(new)=${formatUsd(expectedTotalCreditsUsd - spent)}\n`
    );

    if (apply) {
      sub.totalCreditsUsd = expectedTotalCreditsUsd;
      // На всякий случай нормализуем profitShare в сохраненных данных
      if (!isFiniteNumber(sub.profitShare)) sub.profitShare = profitShare;
      await saveJson(key, sub);
    }

    changed += 1;
  }

  console.log(`[fixCredits] Done. scanned=${scanned} changed=${changed} skipped=${skipped} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);
}

main().catch((err) => {
  console.error('[fixCredits] Fatal:', err);
  process.exitCode = 1;
});


