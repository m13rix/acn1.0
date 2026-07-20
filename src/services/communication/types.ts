export type TelosEventPriority = 'normal' | 'high' | 'realtime';
export type TelosDevicePlatform = 'android' | 'web' | 'desktop' | 'server' | 'unknown';
export type TelosEventAckStatus = 'pending' | 'delivered' | 'read';

export interface TelosDeviceRegistration {
  deviceId: string;
  platform: TelosDevicePlatform;
  appId?: string;
  userId?: string;
  fcmToken?: string;
  capabilities?: string[];
  label?: string;
}

export interface TelosDeviceRecord extends TelosDeviceRegistration {
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
}

export interface TelosEventTarget {
  deviceIds?: string[];
  appIds?: string[];
  userIds?: string[];
  broadcast?: boolean;
}

export interface TelosEventRecord<TPayload = unknown> {
  id: string;
  sequence: number;
  type: string;
  priority: TelosEventPriority;
  createdAt: string;
  expiresAt?: string;
  source?: string;
  conversationId?: string;
  target: TelosEventTarget;
  payload: TPayload;
  delivery: Record<string, TelosEventAckStatus>;
}

export interface TelosPublishInput<TPayload = unknown> {
  type: string;
  priority?: TelosEventPriority;
  source?: string;
  conversationId?: string;
  target?: TelosEventTarget;
  payload: TPayload;
  ttlMs?: number;
}

export interface TelosAckInput {
  deviceId: string;
  eventIds?: string[];
  throughSequence?: number;
  status?: TelosEventAckStatus;
}

export interface TelosCommunicationState {
  version: 1;
  nextSequence: number;
  devices: Record<string, TelosDeviceRecord>;
  events: TelosEventRecord[];
}
