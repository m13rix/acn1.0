import { createSign } from 'crypto';
import { readFile } from 'fs/promises';

import type { TelosDeviceRecord, TelosEventRecord } from './types.js';

interface ServiceAccount {
  project_id?: string;
  client_email?: string;
  private_key?: string;
}

interface AccessToken {
  token: string;
  expiresAt: number;
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function encodeDataValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function readServiceAccountFromEnv(): ServiceAccount | null {
  const inline = process.env.TELOS_FCM_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (inline?.trim()) {
    return JSON.parse(inline) as ServiceAccount;
  }
  return null;
}

async function readServiceAccount(): Promise<ServiceAccount | null> {
  const fromEnv = readServiceAccountFromEnv();
  if (fromEnv) {
    return fromEnv;
  }
  const filePath = process.env.TELOS_FCM_SERVICE_ACCOUNT_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!filePath?.trim()) {
    return null;
  }
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content) as ServiceAccount;
}

export class FcmSender {
  private serviceAccountPromise: Promise<ServiceAccount | null> | null = null;
  private accessToken: AccessToken | null = null;

  async isConfigured(): Promise<boolean> {
    const serviceAccount = await this.getServiceAccount();
    return !!(serviceAccount?.project_id && serviceAccount.client_email && serviceAccount.private_key);
  }

  async sendEvent(device: TelosDeviceRecord, event: TelosEventRecord): Promise<void> {
    if (!device.fcmToken) {
      return;
    }
    const serviceAccount = await this.getServiceAccount();
    if (!serviceAccount?.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
      return;
    }
    const token = await this.getAccessToken(serviceAccount);
    const isHighPriority = event.priority === 'high' || event.priority === 'realtime';
    const data = {
      eventId: event.id,
      sequence: String(event.sequence),
      type: event.type,
      priority: event.priority,
      source: event.source || '',
      conversationId: event.conversationId || '',
      payload: encodeDataValue(event.payload),
    };
    const notification = this.notificationForEvent(event);
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: device.fcmToken,
          data,
          ...(notification ? { notification } : {}),
          android: {
            priority: isHighPriority ? 'HIGH' : 'NORMAL',
            ttl: event.expiresAt
              ? `${Math.max(0, Math.floor((new Date(event.expiresAt).getTime() - Date.now()) / 1000))}s`
              : undefined,
          },
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`FCM send failed: HTTP ${response.status}${text ? ` ${text}` : ''}`);
    }
  }

  private notificationForEvent(event: TelosEventRecord): { title: string; body: string } | null {
    if (event.type === 'advisor.response') {
      const payload = event.payload as { advice?: unknown };
      const body = String(payload?.advice || '').trim();
      return {
        title: 'Telos advice',
        body: body.slice(0, 180) || 'New advice is ready.',
      };
    }
    if (event.type === 'speaker.proposal') {
      return {
        title: 'New voice detected',
        body: 'Tap to identify this speaker.',
      };
    }
    if (event.priority === 'high' || event.priority === 'realtime') {
      return {
        title: 'Telos',
        body: event.type,
      };
    }
    return null;
  }

  private async getServiceAccount(): Promise<ServiceAccount | null> {
    this.serviceAccountPromise ??= readServiceAccount();
    return this.serviceAccountPromise;
  }

  private async getAccessToken(serviceAccount: ServiceAccount): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - Date.now() > 60_000) {
      return this.accessToken.token;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const unsigned = [
      base64UrlJson({ alg: 'RS256', typ: 'JWT' }),
      base64UrlJson({
        iss: serviceAccount.client_email,
        scope: FCM_SCOPE,
        aud: TOKEN_URL,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
    ].join('.');
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(serviceAccount.private_key!, 'base64url');
    const assertion = `${unsigned}.${signature}`;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`FCM token exchange failed: HTTP ${response.status}${text ? ` ${text}` : ''}`);
    }
    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new Error('FCM token exchange did not return access_token.');
    }
    this.accessToken = {
      token: body.access_token,
      expiresAt: Date.now() + Math.max(1, body.expires_in || 3600) * 1000,
    };
    return this.accessToken.token;
  }
}
