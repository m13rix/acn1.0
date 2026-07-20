import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { v7 as uuidv7 } from 'uuid';

import type { ThreadLaunchProfile, ThreadStatus } from '@telos/code-contracts/telos';
import { THREAD_STORE_MIGRATIONS } from './migrations.js';
import type {
  HarnessThread,
  LegacyMigrationIssue,
  LegacyMigrationResult,
  LegacySessionFile,
  StoredThreadEvent,
  StoredInteraction,
  StoredTurn,
  StoredAppClient,
  StoredTerminalSession,
  ThreadProject,
  WorkspaceCheckpoint,
  WorkspaceCheckpointFile,
} from './types.js';

const LEGACY_MIGRATION_VERSION = 10_001;

interface ThreadStoreOptions {
  databasePath: string;
  legacySessionsPath?: string;
  defaultWorkspacePath?: string;
  now?: () => Date;
  id?: () => string;
}

interface ProjectRow {
  id: string;
  path: string;
  display_name: string;
  repository_identity: string | null;
  snapshot_ignore_json: string;
  created_at: string;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  parent_thread_id: string | null;
  project_id: string;
  launch_profile_json: string;
  title: string;
  status: ThreadStatus;
  active_context_turn_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

interface EventRow {
  thread_id: string;
  sequence: number;
  event_id: string;
  type: string;
  occurred_at: string;
  payload_json: string;
}

interface TurnRow {
  id: string;
  thread_id: string;
  status: StoredTurn['status'];
  input_text: string;
  attachment_ids_json: string;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  requested_effort: string | null;
  effective_effort: string | null;
  error: string | null;
}

interface InteractionRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  state: StoredInteraction['state'];
  request_json: string;
  answer_json: string | null;
  expires_at: string | null;
  answered_at: string | null;
}

interface CheckpointRow {
  id: string;
  timeline_id: string;
  workspace_path: string;
  thread_id: string | null;
  turn_id: string | null;
  name: string | null;
  manifest_hash: string;
  created_at: string;
}

interface CheckpointFileRow {
  relative_path: string;
  content_hash: string | null;
  kind: WorkspaceCheckpointFile['kind'];
  size: number;
  mode: number | null;
  symlink_target: string | null;
  mtime_ms: number | null;
}

interface AppClientRow {
  id: string;
  app_id: string;
  device_name: string;
  signing_public_key: string;
  exchange_public_key: string;
  fingerprint: string;
  capabilities_json: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface TerminalSessionRow {
  id: string;
  thread_id: string;
  cwd: string;
  command: string;
  status: StoredTerminalSession['status'];
  history: string;
  cols: number;
  rows: number;
  pid: number | null;
  exit_code: number | null;
  exit_signal: number | null;
  label: string;
  sequence: number;
  has_running_subprocess: number;
  created_at: string;
  updated_at: string;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function interactionFromRow(row: InteractionRow): StoredInteraction {
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    state: row.state,
    request: parseJson<Record<string, unknown>>(row.request_json),
    answer: row.answer_json ? parseJson<Record<string, unknown>>(row.answer_json) : null,
    expiresAt: row.expires_at,
    answeredAt: row.answered_at,
  };
}

function titleFromLegacySession(session: LegacySessionFile): string {
  const firstUserMessage = session.snapshot.messages.find((message) => message.role === 'user');
  const content = typeof firstUserMessage?.content === 'string' ? firstUserMessage.content.trim() : '';
  return content ? content.slice(0, 80) : `Legacy ${session.agentName} thread`;
}

function projectFromRow(row: ProjectRow): ThreadProject {
  return {
    id: row.id,
    path: row.path,
    displayName: row.display_name,
    repositoryIdentity: row.repository_identity,
    snapshotIgnore: parseJson<string[]>(row.snapshot_ignore_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function threadFromRow(row: ThreadRow): HarnessThread {
  return {
    id: row.id,
    parentThreadId: row.parent_thread_id,
    projectId: row.project_id,
    launchProfile: parseJson<ThreadLaunchProfile>(row.launch_profile_json),
    title: row.title,
    status: row.status,
    activeContextTurnId: row.active_context_turn_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function checkpointFromRow(row: CheckpointRow): WorkspaceCheckpoint {
  return {
    id: row.id,
    timelineId: row.timeline_id,
    workspacePath: row.workspace_path,
    threadId: row.thread_id,
    turnId: row.turn_id,
    name: row.name,
    manifestHash: row.manifest_hash,
    createdAt: row.created_at,
  };
}

function checkpointFileFromRow(row: CheckpointFileRow): WorkspaceCheckpointFile {
  return {
    relativePath: row.relative_path,
    contentHash: row.content_hash,
    kind: row.kind,
    size: row.size,
    mode: row.mode,
    symlinkTarget: row.symlink_target,
    mtimeMs: row.mtime_ms,
  };
}

function appClientFromRow(row: AppClientRow): StoredAppClient {
  return {
    id: row.id,
    appId: row.app_id,
    deviceName: row.device_name,
    signingPublicKey: row.signing_public_key,
    exchangePublicKey: row.exchange_public_key,
    fingerprint: row.fingerprint,
    capabilities: parseJson<string[]>(row.capabilities_json),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

function terminalSessionFromRow(row: TerminalSessionRow): StoredTerminalSession {
  return {
    id: row.id,
    threadId: row.thread_id,
    cwd: row.cwd,
    command: row.command,
    status: row.status,
    history: row.history,
    cols: row.cols,
    rows: row.rows,
    pid: row.pid,
    exitCode: row.exit_code,
    exitSignal: row.exit_signal,
    label: row.label,
    sequence: row.sequence,
    hasRunningSubprocess: row.has_running_subprocess === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ThreadStore {
  private readonly database: Database;
  private readonly legacySessionsPath: string | undefined;
  private readonly defaultWorkspacePath: string;
  private readonly now: () => Date;
  private readonly id: () => string;

  private constructor(options: ThreadStoreOptions) {
    this.database = new Database(options.databasePath);
    this.legacySessionsPath = options.legacySessionsPath;
    this.defaultWorkspacePath = resolve(options.defaultWorkspacePath || process.cwd());
    this.now = options.now || (() => new Date());
    this.id = options.id || uuidv7;
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.applyMigrations();
  }

  public static async open(options: ThreadStoreOptions): Promise<ThreadStore> {
    await mkdir(dirname(options.databasePath), { recursive: true });
    return new ThreadStore(options);
  }

  public close(): void {
    this.database.close();
  }

  private applyMigrations(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      (this.database.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
        (row) => row.version,
      ),
    );
    for (const migration of THREAD_STORE_MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.database.transaction(() => {
        this.database.exec(migration.sql);
        this.database
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(migration.version, this.now().toISOString());
      })();
    }
  }

  public createProject(input: {
    id?: string;
    path: string;
    displayName?: string;
    repositoryIdentity?: string | null;
    snapshotIgnore?: string[];
  }): ThreadProject {
    const path = resolve(input.path);
    const timestamp = this.now().toISOString();
    const id = input.id || this.id();
    this.database
      .prepare(
        `INSERT INTO projects
          (id, path, display_name, repository_identity, snapshot_ignore_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        path,
        input.displayName?.trim() || basename(path),
        input.repositoryIdentity || null,
        JSON.stringify(input.snapshotIgnore || []),
        timestamp,
        timestamp,
      );
    return this.getProject(id)!;
  }

  public getProject(id: string): ThreadProject | null {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined;
    return row ? projectFromRow(row) : null;
  }

  public listProjects(): ThreadProject[] {
    return (this.database.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]).map(
      projectFromRow,
    );
  }

  public createThread(input: {
    id?: string;
    parentThreadId?: string | null;
    launchProfile: ThreadLaunchProfile;
    title?: string;
  }): HarnessThread {
    const id = input.id || this.id();
    const timestamp = this.now().toISOString();
    const title = input.title?.trim() || 'New thread';
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO threads
            (id, parent_thread_id, project_id, launch_profile_json, title, status,
             active_context_turn_id, archived_at, created_at, updated_at, version)
           VALUES (?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?, 1)`,
        )
        .run(
          id,
          input.parentThreadId || null,
          input.launchProfile.projectId,
          JSON.stringify(input.launchProfile),
          title,
          timestamp,
          timestamp,
        );
      this.appendEventInTransaction(id, 'thread.lifecycle', {
        operation: 'created',
        title,
      });
    })();
    return this.getThread(id)!;
  }

  public getThread(id: string): HarnessThread | null {
    const row = this.database.prepare('SELECT * FROM threads WHERE id = ?').get(id) as
      | ThreadRow
      | undefined;
    return row ? threadFromRow(row) : null;
  }

  public listThreads(options: { includeArchived?: boolean; parentThreadId?: string | null } = {}): HarnessThread[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!options.includeArchived) clauses.push('archived_at IS NULL');
    if (options.parentThreadId === null) clauses.push('parent_thread_id IS NULL');
    if (typeof options.parentThreadId === 'string') {
      clauses.push('parent_thread_id = ?');
      params.push(options.parentThreadId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.database.prepare(`SELECT * FROM threads ${where} ORDER BY updated_at DESC`).all(...params) as ThreadRow[]
    ).map(threadFromRow);
  }

  public renameThread(threadId: string, title: string, expectedVersion?: number): HarnessThread {
    return this.updateThreadProjection(threadId, expectedVersion, 'title = ?', [title.trim()], 'renamed', {
      title: title.trim(),
    });
  }

  public archiveThread(threadId: string, archived: boolean, expectedVersion?: number): HarnessThread {
    const timestamp = this.now().toISOString();
    const ids = [
      threadId,
      ...(this.database
        .prepare('WITH RECURSIVE children(id) AS (SELECT id FROM threads WHERE parent_thread_id = ? UNION ALL SELECT t.id FROM threads t JOIN children c ON t.parent_thread_id = c.id) SELECT id FROM children')
        .all(threadId) as Array<{ id: string }>).map((row) => row.id),
    ];
    this.database.transaction(() => {
      const root = this.getThread(threadId);
      if (!root) throw new Error(`Thread not found: ${threadId}`);
      if (expectedVersion !== undefined && root.version !== expectedVersion) {
        throw new Error(`Thread version conflict: expected ${expectedVersion}, received ${root.version}`);
      }
      for (const id of ids) {
        this.database
          .prepare('UPDATE threads SET archived_at = ?, updated_at = ?, version = version + 1 WHERE id = ?')
          .run(archived ? timestamp : null, timestamp, id);
        this.appendEventInTransaction(id, 'thread.lifecycle', {
          operation: archived ? 'archived' : 'unarchived',
        });
      }
    })();
    return this.getThread(threadId)!;
  }

  public setThreadStatus(
    threadId: string,
    status: ThreadStatus,
    activeContextTurnId?: string | null,
  ): HarnessThread {
    const timestamp = this.now().toISOString();
    const result = this.database
      .prepare(
        `UPDATE threads SET
          status = ?,
          active_context_turn_id = CASE WHEN ? = 1 THEN ? ELSE active_context_turn_id END,
          updated_at = ?,
          version = version + 1
         WHERE id = ?`,
      )
      .run(status, activeContextTurnId !== undefined ? 1 : 0, activeContextTurnId ?? null, timestamp, threadId);
    if (result.changes === 0) throw new Error(`Thread not found: ${threadId}`);
    return this.getThread(threadId)!;
  }

  public createTurn(input: {
    id?: string;
    threadId: string;
    text: string;
    attachmentIds?: string[];
    requestedEffort?: string;
    effectiveEffort?: string;
  }): StoredTurn {
    const id = input.id || this.id();
    this.database
      .prepare(
        `INSERT INTO turns
          (id, thread_id, status, queued_at, requested_effort, effective_effort,
           input_text, attachment_ids_json)
         VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.threadId,
        this.now().toISOString(),
        input.requestedEffort || null,
        input.effectiveEffort || input.requestedEffort || null,
        input.text,
        JSON.stringify(input.attachmentIds || []),
      );
    return this.getTurn(id)!;
  }

  public getTurn(id: string): StoredTurn | null {
    const row = this.database.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
    return row ? this.turnFromRow(row) : null;
  }

  public listTurns(
    threadId: string,
    statuses?: StoredTurn['status'][],
  ): StoredTurn[] {
    const rows = statuses?.length
      ? (this.database
          .prepare(
            `SELECT * FROM turns WHERE thread_id = ? AND status IN (${statuses.map(() => '?').join(',')})
             ORDER BY queued_at ASC`,
          )
          .all(threadId, ...statuses) as TurnRow[])
      : (this.database.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY queued_at ASC').all(threadId) as TurnRow[]);
    return rows.map((row) => this.turnFromRow(row));
  }

  public updateTurn(
    id: string,
    status: StoredTurn['status'],
    input: { error?: string | null } = {},
  ): StoredTurn {
    const timestamp = this.now().toISOString();
    const result = this.database
      .prepare(
        `UPDATE turns SET
          status = ?,
          started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
          completed_at = CASE WHEN ? IN ('stopped', 'completed', 'failed') THEN ? ELSE completed_at END,
          error = ?
         WHERE id = ?`,
      )
      .run(status, status, timestamp, status, timestamp, input.error ?? null, id);
    if (result.changes === 0) throw new Error(`Turn not found: ${id}`);
    return this.getTurn(id)!;
  }

  private turnFromRow(row: TurnRow): StoredTurn {
    return {
      id: row.id,
      threadId: row.thread_id,
      status: row.status,
      inputText: row.input_text,
      attachmentIds: parseJson<string[]>(row.attachment_ids_json),
      queuedAt: row.queued_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      requestedEffort: row.requested_effort,
      effectiveEffort: row.effective_effort,
      error: row.error,
    };
  }

  public createInteraction(input: {
    id?: string;
    threadId: string;
    turnId?: string | null;
    request: Record<string, unknown>;
    expiresAt?: string | null;
  }): StoredInteraction {
    const id = input.id || this.id();
    this.database
      .prepare(
        `INSERT INTO interactions
          (id, thread_id, turn_id, state, request_json, answer_json, expires_at, answered_at)
         VALUES (?, ?, ?, 'waiting', ?, NULL, ?, NULL)`,
      )
      .run(
        id,
        input.threadId,
        input.turnId || null,
        JSON.stringify(input.request),
        input.expiresAt || null,
      );
    return this.getInteraction(id)!;
  }

  public getInteraction(id: string): StoredInteraction | null {
    const row = this.database.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as
      | InteractionRow
      | undefined;
    return row ? interactionFromRow(row) : null;
  }

  public answerInteraction(
    id: string,
    answer: Record<string, unknown>,
  ): { accepted: boolean; interaction: StoredInteraction } {
    return this.database.transaction(() => {
      const current = this.getInteraction(id);
      if (!current) throw new Error(`Interaction not found: ${id}`);
      if (current.state !== 'waiting') return { accepted: false, interaction: current };
      const now = this.now();
      if (current.expiresAt && Date.parse(current.expiresAt) <= now.getTime()) {
        this.database.prepare("UPDATE interactions SET state = 'expired' WHERE id = ? AND state = 'waiting'").run(id);
        return { accepted: false, interaction: this.getInteraction(id)! };
      }
      const result = this.database
        .prepare(
          `UPDATE interactions SET state = 'answered', answer_json = ?, answered_at = ?
           WHERE id = ? AND state = 'waiting'`,
        )
        .run(JSON.stringify(answer), now.toISOString(), id);
      return { accepted: result.changes === 1, interaction: this.getInteraction(id)! };
    })();
  }

  public expireInteraction(id: string): StoredInteraction {
    this.database
      .prepare("UPDATE interactions SET state = 'expired' WHERE id = ? AND state = 'waiting'")
      .run(id);
    const interaction = this.getInteraction(id);
    if (!interaction) throw new Error(`Interaction not found: ${id}`);
    return interaction;
  }

  public saveTerminalSession(input: {
    id: string;
    threadId: string;
    cwd: string;
    command?: string;
    status: StoredTerminalSession['status'];
    history?: string;
    cols: number;
    rows: number;
    pid?: number | null;
    exitCode?: number | null;
    exitSignal?: number | null;
    label?: string;
    sequence?: number;
    hasRunningSubprocess?: boolean;
  }): StoredTerminalSession {
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `INSERT INTO terminal_sessions
          (id, thread_id, cwd, status, history_path, created_at, updated_at, command, history,
           cols, rows, pid, exit_code, exit_signal, label, sequence, has_running_subprocess)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           thread_id = excluded.thread_id,
           cwd = excluded.cwd,
           status = excluded.status,
           updated_at = excluded.updated_at,
           command = excluded.command,
           history = excluded.history,
           cols = excluded.cols,
           rows = excluded.rows,
           pid = excluded.pid,
           exit_code = excluded.exit_code,
           exit_signal = excluded.exit_signal,
           label = excluded.label,
           sequence = excluded.sequence,
           has_running_subprocess = excluded.has_running_subprocess`,
      )
      .run(
        input.id,
        input.threadId,
        input.cwd,
        input.status,
        timestamp,
        timestamp,
        input.command || '',
        input.history || '',
        input.cols,
        input.rows,
        input.pid ?? null,
        input.exitCode ?? null,
        input.exitSignal ?? null,
        input.label || 'Shell',
        input.sequence || 0,
        input.hasRunningSubprocess ? 1 : 0,
      );
    return this.getTerminalSession(input.id)!;
  }

  public getTerminalSession(id: string): StoredTerminalSession | null {
    const row = this.database.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(id) as
      | TerminalSessionRow
      | undefined;
    return row ? terminalSessionFromRow(row) : null;
  }

  public listTerminalSessions(threadId: string): StoredTerminalSession[] {
    return (this.database
      .prepare('SELECT * FROM terminal_sessions WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as TerminalSessionRow[]).map(terminalSessionFromRow);
  }

  public deleteTerminalSession(id: string): void {
    this.database.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(id);
  }

  public markLiveTerminalsExited(): void {
    const timestamp = this.now().toISOString();
    this.database
      .prepare(
        `UPDATE terminal_sessions SET
           status = 'exited', pid = NULL, has_running_subprocess = 0,
           history = history || ?, sequence = sequence + 1, updated_at = ?
         WHERE status IN ('starting', 'running')`,
      )
      .run('\n[Harness restarted; the terminal process is no longer running.]\n', timestamp);
  }

  public deleteThread(threadId: string): void {
    this.database.transaction(() => {
      const thread = this.getThread(threadId);
      if (!thread) return;
      if (thread.parentThreadId) {
        this.appendEventInTransaction(thread.parentThreadId, 'activity', {
          activityType: 'child-thread',
          state: 'deleted',
          childThreadId: threadId,
          title: thread.title,
        });
      }
      this.database.prepare('DELETE FROM checkpoints WHERE thread_id = ?').run(threadId);
      this.database.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
    })();
  }

  private updateThreadProjection(
    threadId: string,
    expectedVersion: number | undefined,
    assignment: string,
    assignmentParams: unknown[],
    operation: string,
    eventPayload: Record<string, unknown>,
  ): HarnessThread {
    this.database.transaction(() => {
      const current = this.getThread(threadId);
      if (!current) throw new Error(`Thread not found: ${threadId}`);
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new Error(`Thread version conflict: expected ${expectedVersion}, received ${current.version}`);
      }
      this.database
        .prepare(`UPDATE threads SET ${assignment}, updated_at = ?, version = version + 1 WHERE id = ?`)
        .run(...assignmentParams, this.now().toISOString(), threadId);
      this.appendEventInTransaction(threadId, 'thread.lifecycle', { operation, ...eventPayload });
    })();
    return this.getThread(threadId)!;
  }

  public appendEvent(
    threadId: string,
    type: string,
    payload: Record<string, unknown>,
    eventId?: string,
  ): StoredThreadEvent {
    return this.database.transaction(() => this.appendEventInTransaction(threadId, type, payload, eventId))();
  }

  private appendEventInTransaction(
    threadId: string,
    type: string,
    payload: Record<string, unknown>,
    eventId = this.id(),
  ): StoredThreadEvent {
    const occurredAt = this.now().toISOString();
    const current = this.database
      .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM thread_events WHERE thread_id = ?')
      .get(threadId) as { sequence: number };
    const sequence = current.sequence + 1;
    this.database
      .prepare(
        `INSERT INTO thread_events (thread_id, sequence, event_id, type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, sequence, eventId, type, occurredAt, JSON.stringify(payload));
    this.database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(occurredAt, threadId);
    return { threadId, sequence, eventId, type, occurredAt, payload };
  }

  public replayEvents(threadId: string, afterSequence: number, limit = 500): StoredThreadEvent[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM thread_events
           WHERE thread_id = ? AND sequence > ?
           ORDER BY sequence ASC LIMIT ?`,
        )
        .all(threadId, afterSequence, limit) as EventRow[]
    ).map((row) => ({
      threadId: row.thread_id,
      sequence: row.sequence,
      eventId: row.event_id,
      type: row.type,
      occurredAt: row.occurred_at,
      payload: parseJson<Record<string, unknown>>(row.payload_json),
    }));
  }

  public saveExecutorSnapshot(
    threadId: string,
    snapshot: unknown,
    activeContextTurnId: string | null,
  ): void {
    const encoded = JSON.stringify(snapshot);
    const timestamp = this.now().toISOString();
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO executor_snapshots
          (thread_id, version, active_context_turn_id, snapshot_json, updated_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           version = version + 1,
           active_context_turn_id = excluded.active_context_turn_id,
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`,
        )
        .run(threadId, activeContextTurnId, encoded, timestamp);
      if (activeContextTurnId) {
        this.database
          .prepare(
            `INSERT INTO executor_snapshot_history (thread_id, turn_id, snapshot_json, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(thread_id, turn_id) DO UPDATE SET
               snapshot_json = excluded.snapshot_json,
               created_at = excluded.created_at`,
          )
          .run(threadId, activeContextTurnId, encoded, timestamp);
      }
    })();
  }

  public restoreExecutorSnapshot(threadId: string, turnId: string): {
    activeContextTurnId: string;
    snapshot: unknown;
  } {
    const row = this.database
      .prepare(
        `SELECT snapshot_json FROM executor_snapshot_history
         WHERE thread_id = ? AND turn_id = ?`,
      )
      .get(threadId, turnId) as { snapshot_json: string } | undefined;
    if (!row) throw new Error(`Executor snapshot is unavailable for turn: ${turnId}`);
    const snapshot = parseJson<unknown>(row.snapshot_json);
    this.saveExecutorSnapshot(threadId, snapshot, turnId);
    this.setThreadStatus(threadId, 'idle', turnId);
    return { activeContextTurnId: turnId, snapshot };
  }

  public clearExecutorSnapshot(threadId: string): void {
    this.database.prepare('DELETE FROM executor_snapshots WHERE thread_id = ?').run(threadId);
    this.setThreadStatus(threadId, 'idle', null);
  }

  public getExecutorSnapshot(threadId: string): {
    version: number;
    activeContextTurnId: string | null;
    snapshot: unknown;
  } | null {
    const row = this.database
      .prepare('SELECT version, active_context_turn_id, snapshot_json FROM executor_snapshots WHERE thread_id = ?')
      .get(threadId) as
      | { version: number; active_context_turn_id: string | null; snapshot_json: string }
      | undefined;
    return row
      ? {
          version: row.version,
          activeContextTurnId: row.active_context_turn_id,
          snapshot: parseJson<unknown>(row.snapshot_json),
        }
      : null;
  }

  public createWorkspaceCheckpoint(input: {
    id?: string;
    workspacePath: string;
    threadId?: string | null;
    turnId?: string | null;
    name?: string | null;
    manifestHash: string;
    files: WorkspaceCheckpointFile[];
  }): WorkspaceCheckpoint {
    const workspacePath = resolve(input.workspacePath);
    const checkpointId = input.id || this.id();
    const createdAt = this.now().toISOString();
    this.database.transaction(() => {
      let timeline = this.database
        .prepare('SELECT id FROM workspace_timelines WHERE workspace_path = ?')
        .get(workspacePath) as { id: string } | undefined;
      if (!timeline) {
        timeline = { id: this.id() };
        this.database
          .prepare('INSERT INTO workspace_timelines (id, workspace_path, created_at) VALUES (?, ?, ?)')
          .run(timeline.id, workspacePath, createdAt);
      }
      this.database
        .prepare(
          `INSERT INTO checkpoints
            (id, timeline_id, thread_id, turn_id, name, manifest_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          checkpointId,
          timeline.id,
          input.threadId || null,
          input.turnId || null,
          input.name?.trim() || null,
          input.manifestHash,
          createdAt,
        );
      const insertFile = this.database.prepare(
        `INSERT INTO checkpoint_files
          (checkpoint_id, relative_path, content_hash, kind, size, mode, symlink_target, mtime_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const file of input.files) {
        insertFile.run(
          checkpointId,
          file.relativePath,
          file.contentHash,
          file.kind,
          file.size,
          file.mode,
          file.symlinkTarget,
          file.mtimeMs,
        );
      }
    })();
    return this.getCheckpoint(checkpointId)!;
  }

  public getCheckpoint(checkpointId: string): WorkspaceCheckpoint | null {
    const row = this.database
      .prepare(
        `SELECT c.*, t.workspace_path
         FROM checkpoints c JOIN workspace_timelines t ON t.id = c.timeline_id
         WHERE c.id = ?`,
      )
      .get(checkpointId) as CheckpointRow | undefined;
    return row ? checkpointFromRow(row) : null;
  }

  public listCheckpoints(input: { threadId?: string; workspacePath?: string } = {}): WorkspaceCheckpoint[] {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (input.threadId) {
      clauses.push('c.thread_id = ?');
      parameters.push(input.threadId);
    }
    if (input.workspacePath) {
      clauses.push('t.workspace_path = ?');
      parameters.push(resolve(input.workspacePath));
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (
      this.database
        .prepare(
          `SELECT c.*, t.workspace_path
           FROM checkpoints c JOIN workspace_timelines t ON t.id = c.timeline_id
           ${where} ORDER BY c.created_at DESC, c.id DESC`,
        )
        .all(...parameters) as CheckpointRow[]
    ).map(checkpointFromRow);
  }

  public getCheckpointFiles(checkpointId: string): WorkspaceCheckpointFile[] {
    return (
      this.database
        .prepare('SELECT * FROM checkpoint_files WHERE checkpoint_id = ? ORDER BY relative_path ASC')
        .all(checkpointId) as CheckpointFileRow[]
    ).map(checkpointFileFromRow);
  }

  public deleteCheckpoint(checkpointId: string): string[] {
    return this.database.transaction(() => {
      const candidates = (
        this.database
          .prepare(
            'SELECT DISTINCT content_hash FROM checkpoint_files WHERE checkpoint_id = ? AND content_hash IS NOT NULL',
          )
          .all(checkpointId) as Array<{ content_hash: string }>
      ).map((row) => row.content_hash);
      this.database.prepare('DELETE FROM checkpoints WHERE id = ?').run(checkpointId);
      const referenced = this.database.prepare(
        'SELECT 1 FROM checkpoint_files WHERE content_hash = ? LIMIT 1',
      );
      return candidates.filter((hash) => !referenced.get(hash));
    })();
  }

  public executeIdempotently<T>(commandId: string, commandType: string, execute: () => T): T {
    const prior = this.database
      .prepare('SELECT result_json FROM command_deduplication WHERE command_id = ?')
      .get(commandId) as { result_json: string } | undefined;
    if (prior) return parseJson<T>(prior.result_json);
    return this.database.transaction(() => {
      const result = execute();
      this.database
        .prepare(
          'INSERT INTO command_deduplication (command_id, command_type, result_json, executed_at) VALUES (?, ?, ?, ?)',
        )
        .run(commandId, commandType, JSON.stringify(result), this.now().toISOString());
      return result;
    })();
  }

  public getCommandResult<T>(commandId: string): T | null {
    const row = this.database
      .prepare('SELECT result_json FROM command_deduplication WHERE command_id = ?')
      .get(commandId) as { result_json: string } | undefined;
    return row ? parseJson<T>(row.result_json) : null;
  }

  public saveCommandResult<T>(commandId: string, commandType: string, result: T): T {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO command_deduplication
          (command_id, command_type, result_json, executed_at) VALUES (?, ?, ?, ?)`,
      )
      .run(commandId, commandType, JSON.stringify(result), this.now().toISOString());
    return this.getCommandResult<T>(commandId) ?? result;
  }

  public setActiveThread(routeId: string, interfaceType: string, threadId: string | null): void {
    this.database
      .prepare(
        `INSERT INTO interface_routes (route_id, interface_type, active_thread_id, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(route_id) DO UPDATE SET
           interface_type = excluded.interface_type,
           active_thread_id = excluded.active_thread_id,
           updated_at = excluded.updated_at`,
      )
      .run(routeId, interfaceType, threadId, this.now().toISOString());
  }

  public getActiveThread(routeId: string): string | null {
    const row = this.database.prepare('SELECT active_thread_id FROM interface_routes WHERE route_id = ?').get(routeId) as
      | { active_thread_id: string | null }
      | undefined;
    return row?.active_thread_id || null;
  }

  public saveAppClient(client: StoredAppClient): StoredAppClient {
    this.database
      .prepare(
        `INSERT INTO app_clients
          (id, app_id, device_name, signing_public_key, exchange_public_key, fingerprint,
           capabilities_json, created_at, last_seen_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           device_name = excluded.device_name,
           signing_public_key = excluded.signing_public_key,
           exchange_public_key = excluded.exchange_public_key,
           fingerprint = excluded.fingerprint,
           capabilities_json = excluded.capabilities_json,
           last_seen_at = excluded.last_seen_at,
           revoked_at = excluded.revoked_at`,
      )
      .run(
        client.id,
        client.appId,
        client.deviceName,
        client.signingPublicKey,
        client.exchangePublicKey,
        client.fingerprint,
        JSON.stringify(client.capabilities),
        client.createdAt,
        client.lastSeenAt,
        client.revokedAt,
      );
    return this.getAppClient(client.id)!;
  }

  public getAppClient(id: string): StoredAppClient | null {
    const row = this.database.prepare('SELECT * FROM app_clients WHERE id = ?').get(id) as
      | AppClientRow
      | undefined;
    return row ? appClientFromRow(row) : null;
  }

  public listAppClients(): StoredAppClient[] {
    return (this.database.prepare('SELECT * FROM app_clients ORDER BY created_at DESC').all() as AppClientRow[])
      .map(appClientFromRow);
  }

  public revokeAppClient(id: string, revokedAt = this.now().toISOString()): StoredAppClient | null {
    this.database.prepare('UPDATE app_clients SET revoked_at = ? WHERE id = ?').run(revokedAt, id);
    return this.getAppClient(id);
  }

  public async migrateLegacySessions(): Promise<LegacyMigrationResult> {
    const completed = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(LEGACY_MIGRATION_VERSION);
    if (completed) {
      return { importedThreads: 0, importedProjects: 0, skipped: [], alreadyCompleted: true };
    }

    const path = this.legacySessionsPath;
    if (!path || !existsSync(path)) {
      this.markLegacyMigrationComplete();
      return { importedThreads: 0, importedProjects: 0, skipped: [], alreadyCompleted: false };
    }

    const skipped: LegacyMigrationIssue[] = [];
    const sessions: Array<{ file: string; value: LegacySessionFile }> = [];
    const entries = await readdir(path);
    for (const file of entries.filter((entry) => entry.endsWith('.json') && entry !== 'route-index.json')) {
      try {
        const value = parseJson<LegacySessionFile>(await readFile(join(path, file), 'utf8'));
        if (
          value.version !== 1 ||
          typeof value.sessionKey !== 'string' ||
          typeof value.agentName !== 'string' ||
          !value.snapshot ||
          !Array.isArray(value.snapshot.messages)
        ) {
          throw new Error('unsupported legacy session shape');
        }
        sessions.push({ file, value });
      } catch (error) {
        skipped.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    let routeIndex: Record<string, { agentName?: string; runPath?: string }> = {};
    try {
      routeIndex = parseJson<Record<string, { agentName?: string; runPath?: string }>>(
        await readFile(join(path, 'route-index.json'), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        skipped.push({ file: 'route-index.json', reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const beforeProjects = this.listProjects().length;
    this.database.transaction(() => {
      const threadByAgentAndPath = new Map<string, string>();
      for (const { value } of sessions) {
        const workspacePath = resolve(value.runPath || this.defaultWorkspacePath);
        let project = this.database.prepare('SELECT * FROM projects WHERE path = ?').get(workspacePath) as
          | ProjectRow
          | undefined;
        if (!project) {
          const projectId = this.id();
          const timestamp = value.savedAt || this.now().toISOString();
          this.database
            .prepare(
              `INSERT INTO projects
                (id, path, display_name, repository_identity, snapshot_ignore_json, created_at, updated_at)
               VALUES (?, ?, ?, NULL, '[]', ?, ?)`,
            )
            .run(projectId, workspacePath, basename(workspacePath), timestamp, timestamp);
          project = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as ProjectRow;
        }

        const threadId = this.id();
        const timestamp = value.savedAt || this.now().toISOString();
        const launchProfile: ThreadLaunchProfile = {
          projectId: project.id as ThreadLaunchProfile['projectId'],
          workspacePath,
          worktreePath: null,
          agentName: value.agentName,
          resolvedAgentConfig: { preserveSession: true, legacyImported: true },
          providerId: 'legacy',
          modelId: 'legacy',
          reasoning: 'off',
        };
        this.database
          .prepare(
            `INSERT INTO threads
              (id, parent_thread_id, project_id, launch_profile_json, title, status,
               active_context_turn_id, archived_at, created_at, updated_at, version)
             VALUES (?, NULL, ?, ?, ?, 'idle', NULL, NULL, ?, ?, 1)`,
          )
          .run(threadId, project.id, JSON.stringify(launchProfile), titleFromLegacySession(value), timestamp, timestamp);

        this.appendEventInTransaction(threadId, 'thread.lifecycle', {
          operation: 'created',
          legacySessionKey: value.sessionKey,
        });
        for (const message of value.snapshot.messages) {
          this.appendEventInTransaction(threadId, 'message', {
            role: message.role,
            content: message.content,
            legacy: true,
          });
        }
        this.saveExecutorSnapshot(threadId, value.snapshot, null);
        threadByAgentAndPath.set(`${value.agentName.toLowerCase()}\0${workspacePath.toLowerCase()}`, threadId);
      }

      for (const [routeId, selection] of Object.entries(routeIndex)) {
        const workspacePath = resolve(selection.runPath || this.defaultWorkspacePath);
        const key = `${(selection.agentName || '').toLowerCase()}\0${workspacePath.toLowerCase()}`;
        const activeThreadId = threadByAgentAndPath.get(key) || null;
        this.setActiveThread(routeId, 'telegram', activeThreadId);
      }
      this.markLegacyMigrationComplete();
    })();

    return {
      importedThreads: sessions.length,
      importedProjects: this.listProjects().length - beforeProjects,
      skipped,
      alreadyCompleted: false,
    };
  }

  private markLegacyMigrationComplete(): void {
    this.database
      .prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(LEGACY_MIGRATION_VERSION, this.now().toISOString());
  }
}
