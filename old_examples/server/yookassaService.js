/**
 * YooKassa Service (API v3)
 * Creates payments with confirmation.type=embedded for Checkout Widget.
 */

import crypto from 'crypto';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getAuthHeader() {
  const shopId = requireEnv('YOOKASSA_SHOP_ID');
  const secretKey = requireEnv('YOOKASSA_SECRET_KEY');
  const basic = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
  return `Basic ${basic}`;
}

function apiBase() {
  return process.env.YOOKASSA_API_URL || 'https://api.yookassa.ru';
}

function makeIdempotenceKey() {
  // YooKassa: up to 64 chars; UUID v4 is perfect
  return crypto.randomUUID();
}

async function yookassaRequest(path, { method = 'GET', idempotenceKey, body } = {}) {
  const url = `${apiBase()}${path}`;
  const headers = {
    'Authorization': getAuthHeader(),
    'Accept': 'application/json'
  };

  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg =
      data?.description ||
      data?.message ||
      `${res.status} ${res.statusText}`;
    const err = new Error(`YooKassa API error: ${msg}`);
    err.status = res.status;
    err.details = data;
    throw err;
  }

  return data;
}

export async function createPayment({
  amountRub,
  description,
  metadata,
  capture = true
}) {
  const valueNum = typeof amountRub === 'number' ? amountRub : Number(amountRub);
  if (!Number.isFinite(valueNum) || valueNum <= 0) {
    throw new Error('Invalid amountRub');
  }

  const payload = {
    amount: { value: valueNum.toFixed(2), currency: 'RUB' },
    confirmation: { type: 'embedded' },
    capture: !!capture,
    description: String(description || 'Оплата'),
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  };

  const payment = await yookassaRequest('/v3/payments', {
    method: 'POST',
    idempotenceKey: makeIdempotenceKey(),
    body: payload
  });

  const confirmationToken = payment?.confirmation?.confirmation_token;
  if (!confirmationToken) {
    throw new Error('YooKassa did not return confirmation_token');
  }

  return {
    paymentId: payment.id,
    status: payment.status,
    paid: payment.paid,
    confirmationToken,
    raw: payment
  };
}

export async function getPaymentStatus(paymentId) {
  if (!paymentId) throw new Error('paymentId required');
  const payment = await yookassaRequest(`/v3/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET'
  });
  return payment;
}


