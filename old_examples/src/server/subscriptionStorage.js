/**
 * Subscription Storage Module
 * Persists per-user subscription and period usage state using the same S3/local fallback as chat storage.
 */

import { loadJson, saveJson } from './s3Storage.js';
import { getRubToUsdRate, rubToUsd } from './currencyService.js';

const SUB_PREFIX = 'billing/subscriptions/';

function subKey(userId) {
  return `${SUB_PREFIX}${userId}/subscription.json`;
}

function nowIso() {
  return new Date().toISOString();
}

function startOfDayIso(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function addDays(dateIso, days) {
  const d = new Date(dateIso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function normalizePeriodDays(period) {
  const p = String(period || '').toLowerCase();
  if (p === 'day' || p === '1' || p === 'd') return 1;
  if (p === 'week' || p === '7' || p === 'w') return 7;
  if (p === 'month' || p === '30' || p === 'm') return 30;
  if (p === 'half-year' || p === 'halfyear' || p === '6m' || p === '180') return 180;
  if (p === 'year' || p === '12m' || p === '365' || p === 'y') return 365;
  const n = Number(period);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 30;
}

export function validatePlanInput({ planType, priceRub, periodDays }) {
  const allowed = new Set(['standard', 'trial', 'custom']);
  if (!allowed.has(planType)) throw new Error('Invalid planType');

  const price = typeof priceRub === 'number' ? priceRub : Number(priceRub);
  if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid priceRub');

  // Custom must be >= 100 RUB, per spec
  if (planType === 'custom' && price < 100) throw new Error('Custom plan priceRub must be >= 100');

  const pd = typeof periodDays === 'number' ? periodDays : Number(periodDays);
  if (!Number.isFinite(pd) || pd <= 0) throw new Error('Invalid periodDays');

  return { planType, priceRub: price, periodDays: Math.floor(pd) };
}

/**
 * Create or replace active subscription and reset billing period usage.
 * Profit share: default 70% profit => user gets 30% of RUB converted to USD credits.
 */
export async function upsertSubscription(userId, { planType, priceRub, periodDays, profitShare = 0.7 } = {}) {
  if (!userId) throw new Error('userId required');

  const clean = validatePlanInput({ planType, priceRub, periodDays });

  // Если profitShare не передан или не является числом, используем дефолт 0.7 (70% прибыль)
  const ps = (typeof profitShare === 'number' && Number.isFinite(profitShare)) ? profitShare : 0.7;
  if (ps < 0 || ps >= 1) throw new Error('Invalid profitShare');

  const { rate: rateRubToUsd } = await getRubToUsdRate();
  const userShareRub = clean.priceRub * (1 - ps);
  const totalCreditsUsd = rubToUsd(userShareRub, rateRubToUsd);

  const startDate = nowIso();
  const nextPaymentDate = addDays(startDate, clean.periodDays);

  const subscription = {
    planType: clean.planType,
    priceRub: clean.priceRub,
    periodDays: clean.periodDays,
    profitShare: ps,
    fx: { rateRubToUsd, fetchedAt: nowIso() },
    totalCreditsUsd,
    startDate,
    nextPaymentDate,
    isActive: true,
    // Usage state for the current billing period:
    period: {
      totalSpentUsd: 0,
      // day boundary tracking
      day: {
        dayStartIso: startOfDayIso(),
        dailySpentUsd: 0,
        // if user clicks "I know what I'm doing" we allow overspending daily limit
        dailySoftCapBypass: false
      },
      // optional topups added to remaining pool within the same billing period
      topUpUsdTotal: 0
    }
  };

  await saveJson(subKey(userId), subscription);
  return subscription;
}

export async function getSubscription(userId) {
  if (!userId) throw new Error('userId required');
  return await loadJson(subKey(userId));
}

export async function requireActiveSubscription(userId) {
  const sub = await getSubscription(userId);
  if (!sub || !sub.isActive) return { ok: false, reason: 'no_subscription', subscription: sub };

  const now = Date.now();
  const next = Date.parse(sub.nextPaymentDate);
  if (Number.isFinite(next) && now >= next) {
    // Period ended, subscription payment is required. Keep remaining credits as profit (do not roll over).
    return { ok: false, reason: 'payment_due', subscription: sub };
  }

  return { ok: true, subscription: sub };
}

export async function setDailySoftCapBypass(userId, value) {
  const sub = await getSubscription(userId);
  if (!sub) throw new Error('Subscription not found');
  sub.period = sub.period || {};
  sub.period.day = sub.period.day || {};
  sub.period.day.dailySoftCapBypass = !!value;

  if (value) {
    // Store the date when bypass was enabled (YYYY-MM-DD)
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    sub.period.day.bypassDate = d.toISOString().slice(0, 10);
  } else {
    delete sub.period.day.bypassDate;
  }

  await saveJson(subKey(userId), sub);
  return sub;
}

export async function addTopUp(userId, { amountRub, profitShare = 0.7 } = {}) {
  const sub = await getSubscription(userId);
  if (!sub || !sub.isActive) throw new Error('Subscription not found');

  const rub = typeof amountRub === 'number' ? amountRub : Number(amountRub);
  if (!Number.isFinite(rub) || rub <= 0) throw new Error('Invalid top-up amountRub');

  // Если profitShare не передан или не является числом, используем дефолт 0.7 (70% прибыль)
  const ps = (typeof profitShare === 'number' && Number.isFinite(profitShare)) ? profitShare : 0.7;
  if (ps < 0 || ps >= 1) throw new Error('Invalid profitShare');

  const { rate: rateRubToUsd } = await getRubToUsdRate();
  const userShareRub = rub * (1 - ps);
  const addUsd = rubToUsd(userShareRub, rateRubToUsd);

  sub.period = sub.period || {};
  sub.period.topUpUsdTotal = (sub.period.topUpUsdTotal || 0) + addUsd;

  // Also increase the "totalCreditsUsd" pool for the period (so remaining% uses correct denominator if desired)
  sub.totalCreditsUsd = (sub.totalCreditsUsd || 0) + addUsd;

  await saveJson(subKey(userId), sub);
  return { subscription: sub, addedUsd: addUsd, fxRateRubToUsd: rateRubToUsd };
}


