/**
 * Usage Tracker
 * Tracks OpenRouter spending (USD) per user and enforces daily soft caps based on remaining credits.
 */

import { loadJson, saveJson } from './s3Storage.js';
import { getSubscription, requireActiveSubscription } from './subscriptionStorage.js';

const USAGE_PREFIX = 'billing/usage/';

function usageKey(userId) {
  return `${USAGE_PREFIX}${userId}/usage.json`;
}

function dayKey(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysUntil(nextPaymentDateIso) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // start of today local
  const next = new Date(nextPaymentDateIso);
  const end = new Date(next.getFullYear(), next.getMonth(), next.getDate());
  const diffMs = end.getTime() - start.getTime();
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1; // include today
  return Math.max(1, days);
}

export async function getUsage(userId) {
  if (!userId) throw new Error('userId required');
  const existing = await loadJson(usageKey(userId));
  if (existing) return existing;
  const initial = {
    lastDay: dayKey(),
    dailySpentUsd: 0,
    // For debugging/auditing; keep last N by truncation on write
    requests: [],
    totalSpentUsd: 0
  };
  await saveJson(usageKey(userId), initial);
  return initial;
}

async function saveUsage(userId, usage) {
  // Trim request log to keep storage bounded
  const max = Number(process.env.USAGE_LOG_MAX || 2000);
  if (Array.isArray(usage.requests) && usage.requests.length > max) {
    usage.requests = usage.requests.slice(usage.requests.length - max);
  }
  await saveJson(usageKey(userId), usage);
}

export async function computeLimits(userId) {
  const active = await requireActiveSubscription(userId);
  if (!active.ok) {
    return {
      ok: false,
      reason: active.reason,
      subscription: active.subscription || null,
      usage: await getUsage(userId)
    };
  }

  const sub = active.subscription;
  const usage = await getUsage(userId);

  // Reset daily counters if day changed
  const dk = dayKey();
  if (usage.lastDay !== dk) {
    usage.lastDay = dk;
    usage.dailySpentUsd = 0;
    await saveUsage(userId, usage);
  }

  // Check bypass stale state INDEPENDENTLY from usage reset
  // If bypass is on, but bypassDate is missing (legacy/stale) or differs from today -> reset it.
  if (sub.period?.day?.dailySoftCapBypass) {
    const bypassDate = sub.period.day.bypassDate;
    if (bypassDate !== dk) {
      sub.period.day.dailySoftCapBypass = false;
      delete sub.period.day.bypassDate;
      await saveJson(`billing/subscriptions/${userId}/subscription.json`, sub);
    }
  }

  const totalCreditsUsd = Number(sub.totalCreditsUsd || 0);
  const totalSpentUsd = Number(sub.period?.totalSpentUsd || 0);
  const remainingUsd = Math.max(0, totalCreditsUsd - totalSpentUsd);

  const daysLeft = daysUntil(sub.nextPaymentDate);
  const dailyLimitUsd = remainingUsd / daysLeft;

  const dailySpentUsd = Number(usage.dailySpentUsd || 0);
  const dailyPct = dailyLimitUsd > 0 ? (dailySpentUsd / dailyLimitUsd) * 100 : (dailySpentUsd > 0 ? 999 : 0);

  const totalPctLeft = totalCreditsUsd > 0 ? (remainingUsd / totalCreditsUsd) * 100 : 0;

  return {
    ok: true,
    subscription: sub,
    usage,
    remainingUsd,
    dailyLimitUsd,
    dailySpentUsd,
    dailyPct,
    totalPctLeft,
    daysLeft
  };
}

export async function canSpendToday(userId) {
  const limits = await computeLimits(userId);
  if (!limits.ok) return { ok: false, reason: limits.reason, limits };

  // CRITICAL: Always check total budget first, even with bypass
  // Bypass only allows exceeding daily limit, not total budget
  if (limits.remainingUsd <= 0) {
    return { ok: false, reason: 'payment_due', limits };
  }

  const bypass = !!limits.subscription?.period?.day?.dailySoftCapBypass;
  if (bypass) return { ok: true, limits };

  // When daily limit is 0 (no remaining), block unless bypass is enabled
  if (limits.dailyLimitUsd <= 0) return { ok: false, reason: 'daily_limit_exhausted', limits };

  if (limits.dailySpentUsd >= limits.dailyLimitUsd) {
    return { ok: false, reason: 'daily_limit_exhausted', limits };
  }

  return { ok: true, limits };
}

/**
 * Record OpenRouter cost for a user for a single API call.
 * Also mirrors totals into subscription.period.totalSpentUsd.
 */
export async function recordCost(userId, { costUsd, meta = {} } = {}) {
  if (!userId) return null;
  console.log(costUsd)
  const c = typeof costUsd === 'number' ? costUsd : Number(costUsd);
  if (!Number.isFinite(c) || c < 0) return null;

  const usage = await getUsage(userId);
  const dk = dayKey();
  if (usage.lastDay !== dk) {
    usage.lastDay = dk;
    usage.dailySpentUsd = 0;
  }

  usage.dailySpentUsd = Number(usage.dailySpentUsd || 0) + c;
  usage.totalSpentUsd = Number(usage.totalSpentUsd || 0) + c;
  usage.requests = usage.requests || [];
  usage.requests.push({
    ts: new Date().toISOString(),
    costUsd: c,
    ...meta
  });

  await saveUsage(userId, usage);

  // Mirror into subscription period totals
  const sub = await getSubscription(userId);
  if (sub && sub.isActive) {
    sub.period = sub.period || {};
    sub.period.totalSpentUsd = Number(sub.period.totalSpentUsd || 0) + c;
    await saveJson(`billing/subscriptions/${userId}/subscription.json`, sub);
  }

  return usage;
}


