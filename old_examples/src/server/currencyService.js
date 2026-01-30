/**
 * Currency Service
 * Fetches RUB->USD exchange rate using an external API and caches it in-memory.
 *
 * Notes:
 * - Uses exchangerate.host (no key) by default.
 * - Cache TTL is configurable via CURRENCY_CACHE_TTL_MS.
 */

const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour

let cache = {
  fetchedAt: 0,
  rateRubToUsd: null,
  source: null
};

function ttlMs() {
  const raw = process.env.CURRENCY_CACHE_TTL_MS;
  const n = raw ? Number(raw) : DEFAULT_TTL_MS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

export async function getRubToUsdRate({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.rateRubToUsd && now - cache.fetchedAt < ttlMs()) {
    return { rate: cache.rateRubToUsd, source: cache.source, fetchedAt: cache.fetchedAt };
  }

  const url =
    process.env.EXCHANGE_RATE_API_URL ||
    'https://v6.exchangerate-api.com/v6/753ed3b9e9996dfbf79605a0/latest/RUB';

  const res = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });

  if (!res.ok) {
    throw new Error(`Exchange rate API failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const rate = data?.conversion_rates?.USD;
  const rateNum = typeof rate === 'number' ? rate : Number(rate);

  if (!Number.isFinite(rateNum) || rateNum <= 0) {
    throw new Error('Exchange rate API returned invalid RUB->USD rate');
  }

  cache = {
    fetchedAt: now,
    rateRubToUsd: rateNum,
    source: url
  };

  return { rate: rateNum, source: url, fetchedAt: now };
}

export function rubToUsd(rubAmount, rateRubToUsd) {
  const rub = typeof rubAmount === 'number' ? rubAmount : Number(rubAmount);
  const rate = typeof rateRubToUsd === 'number' ? rateRubToUsd : Number(rateRubToUsd);
  if (!Number.isFinite(rub) || rub < 0) throw new Error('Invalid RUB amount');
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid RUB->USD rate');
  return rub * rate;
}


