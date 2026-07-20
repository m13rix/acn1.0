import type {
  TelosCodeEvent,
  ThreadLaunchProfile,
  ThreadStatus,
} from '@telos/code-contracts/telos';
import type { SessionSnapshot } from '../../core/Session.js';

export interface ThreadProject {
  id: string;
  path: string;
  displayName: string;
  repositoryIdentity: string | null;
  snapshotIgnore: string[];
  createdAt: string;
  updatedAt: string;
}

export interface HarnessThread {
  id: string;
  parentThreadId: string | null;
  projectId: string;
  launchProfile: ThreadLaunchProfile;
  title: string;
  status: ThreadStatus;
  activeContextTurnId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface StoredThreadEvent {
  threadId: string;
  sequence: number;
  eventId: string;
  type: string;
  occurredAt: string;
  payload: TelosCodeEvent | Record<string, unknown>;
}

export interface StoredTurn {
  id: string;
  threadId: string;
  status: 'queued' | 'running' | 'stopped' | 'completed' | 'failed';
  inputText: string;
  attachmentIds: string[];
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  requestedEffort: string | null;
  effectiveEffort: string | null;
  error: string | null;
}

export interface StoredInteraction {
  id: string;
  threadId: string;
  turnId: string | null;
  state: 'waiting' | 'answered' | 'expired';
  request: Record<string, unknown>;
  answer: Record<string, unknown> | null;
  expiresAt: string | null;
  answeredAt: string | null;
}

export type WorkspaceEntryKind = 'file' | 'directory' | 'symlink';

export interface WorkspaceCheckpointFile {
  relativePath: string;
  contentHash: string | null;
  kind: WorkspaceEntryKind;
  size: number;
  mode: number | null;
  symlinkTarget: string | null;
  mtimeMs: number | null;
}

export interface WorkspaceCheckpoint {
  id: string;
  timelineId: string;
  workspacePath: string;
  threadId: string | null;
  turnId: string | null;
  name: string | null;
  manifestHash: string;
  createdAt: string;
}

export interface StoredAppClient {
  id: string;
  appId: string;
  deviceName: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  fingerprint: string;
  capabilities: string[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface LegacyMigrationIssue {
  file: string;
  reason: string;
}

export interface LegacyMigrationResult {
  importedThreads: number;
  importedProjects: number;
  skipped: LegacyMigrationIssue[];
  alreadyCompleted: boolean;
}

export interface LegacySessionFile {
  version: 1;
  savedAt: string;
  sessionKey: string;
  agentName: string;
  runPath?: string;
  snapshot: SessionSnapshot;
}
