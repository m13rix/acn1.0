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
