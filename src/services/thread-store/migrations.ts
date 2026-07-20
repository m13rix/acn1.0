export const THREAD_STORE_SCHEMA_VERSION = 2;

export const THREAD_STORE_MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        repository_identity TEXT,
        snapshot_ignore_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        parent_thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        launch_profile_json TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        active_context_turn_id TEXT,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS threads_project_idx ON threads(project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS threads_parent_idx ON threads(parent_thread_id);

      CREATE TABLE IF NOT EXISTS thread_events (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (thread_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        requested_effort TEXT,
        effective_effort TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS executor_snapshots (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        active_context_turn_id TEXT,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT,
        state TEXT NOT NULL,
        request_json TEXT NOT NULL,
        answer_json TEXT,
        expires_at TEXT,
        answered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_timelines (
        id TEXT PRIMARY KEY,
        workspace_path TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        timeline_id TEXT NOT NULL REFERENCES workspace_timelines(id),
        thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        turn_id TEXT,
        name TEXT,
        manifest_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoint_files (
        checkpoint_id TEXT NOT NULL REFERENCES checkpoints(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        content_hash TEXT,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL,
        mode INTEGER,
        symlink_target TEXT,
        PRIMARY KEY (checkpoint_id, relative_path)
      );

      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        history_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_scripts (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        preview_url TEXT,
        auto_open_preview INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS preview_sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interface_routes (
        route_id TEXT PRIMARY KEY,
        interface_type TEXT NOT NULL,
        active_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_clients (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        signing_public_key TEXT NOT NULL,
        exchange_public_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS command_deduplication (
        command_id TEXT PRIMARY KEY,
        command_type TEXT NOT NULL,
        result_json TEXT NOT NULL,
        executed_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE turns ADD COLUMN input_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE turns ADD COLUMN attachment_ids_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
];
