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
  StoredTurn,
  ThreadProject,
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

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
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
      .run(threadId, activeContextTurnId, JSON.stringify(snapshot), this.now().toISOString());
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
