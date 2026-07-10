/**
 * Schema + first-open migration.
 *
 * A single idempotent migration (SQLite `CREATE TABLE IF NOT EXISTS`) runs when
 * the database is opened. A `schema_migrations` table records applied versions
 * so future migrations can be added append-only. Designed to be Postgres-
 * upgradable: no SQLite-only column types are used beyond `INTEGER PRIMARY KEY`.
 */

import type { Database } from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS runs (
        id           TEXT PRIMARY KEY,
        connector    TEXT NOT NULL,
        flow         TEXT NOT NULL,
        engine       TEXT NOT NULL,
        tier         TEXT NOT NULL,
        status       TEXT NOT NULL,
        mode         TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        duration_ms  INTEGER NOT NULL DEFAULT 0,
        output_json  TEXT,
        failure_json TEXT,
        rrweb_ref    TEXT,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS run_steps (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id         TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        idx            INTEGER NOT NULL,
        type           TEXT NOT NULL,
        label          TEXT,
        status         TEXT NOT NULL,
        detail         TEXT,
        healed_from    TEXT,
        healed_to      TEXT,
        screenshot_ref TEXT,
        duration_ms    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id, idx);

      CREATE TABLE IF NOT EXISTS sessions (
        tenant        TEXT NOT NULL,
        credential    TEXT NOT NULL,
        storage_state TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        PRIMARY KEY (tenant, credential)
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT NOT NULL,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        run_id      TEXT,
        target      TEXT,
        detail_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_run_id ON audit_events(run_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS flows (
        id         TEXT PRIMARY KEY,
        key        TEXT NOT NULL,
        version    INTEGER NOT NULL,
        yaml       TEXT NOT NULL,
        status     TEXT NOT NULL,
        source     TEXT NOT NULL,
        connector  TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_flows_key ON flows(key, version DESC);

      CREATE TABLE IF NOT EXISTS browser_sessions (
        id             TEXT PRIMARY KEY,
        tenant         TEXT NOT NULL,
        profile        TEXT,
        cdp_endpoint   TEXT,
        status         TEXT NOT NULL,
        started_at     TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_tenant ON browser_sessions(tenant, status);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS validations (
        id          TEXT PRIMARY KEY,
        flow_id     TEXT NOT NULL,
        passed      INTEGER NOT NULL,
        reasons_json TEXT,
        run_id      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_validations_flow ON validations(flow_id, created_at DESC);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS connectors (
        id             TEXT PRIMARY KEY,
        key            TEXT NOT NULL UNIQUE,
        name           TEXT NOT NULL,
        framework      TEXT,
        base_url       TEXT,
        auth           TEXT,
        variables_json TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_config (
        id         TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        category   TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT,
        secret     INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_app_config_scope ON app_config(scope, category, key);

      ALTER TABLE browser_sessions ADD COLUMN pid INTEGER;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE runs ADD COLUMN instance TEXT;
      ALTER TABLE browser_sessions ADD COLUMN connector TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS recordings (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL,
        connector     TEXT,
        flow_key      TEXT NOT NULL,
        base_url      TEXT,
        status        TEXT NOT NULL,
        path          TEXT NOT NULL,
        pid           INTEGER,
        draft_flow_id TEXT,
        clicks        INTEGER,
        requests      INTEGER,
        error         TEXT,
        started_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recordings_session ON recordings(session_id, started_at DESC);
    `,
  },
  {
    // Async agent-authoring jobs — the author process runs detached and reports
    // progress/result here, so the console can poll and the user can leave and
    // come back to an in-progress or finished run.
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS author_jobs (
        id            TEXT PRIMARY KEY,
        connector     TEXT,
        goal          TEXT NOT NULL,
        start_url     TEXT NOT NULL,
        flow_key      TEXT,
        status        TEXT NOT NULL,        -- 'running' | 'done' | 'failed'
        draft_flow_id TEXT,
        progress      TEXT,                 -- latest human-readable progress line
        error         TEXT,
        pid           INTEGER,
        started_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_author_jobs_started ON author_jobs(started_at DESC);
    `,
  },
  {
    // Per-job progress timeline — every log line from the author process, kept
    // for a live view AND later debugging/review.
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS author_job_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id   TEXT NOT NULL,
        ts       TEXT NOT NULL,
        message  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_author_job_events_job ON author_job_events(job_id, id);
    `,
  },
  {
    // Provenance for authored flows — which LLM (provider/model), rewrite-
    // prompt version, and author-CLI version produced a given flow version,
    // so a flow's authorship is reproducible after the fact.
    version: 9,
    sql: `
      ALTER TABLE flows ADD COLUMN provenance_json TEXT;
    `,
  },
  {
    // Bounded worker concurrency — a durable run queue so a CLI `worker` loop
    // can claim and execute queued flow runs with a bounded number of
    // concurrent children, without a separate message broker. `enqueueRun`
    // inserts 'queued' rows; `claimNextQueued` atomically flips the oldest
    // queued row to 'running' inside an IMMEDIATE transaction so multiple
    // worker processes sharing this DB file never claim the same row;
    // `finishQueued` records the terminal outcome.
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS run_queue (
        id          TEXT PRIMARY KEY,
        flow_id     TEXT NOT NULL,
        inputs_json TEXT,
        status      TEXT NOT NULL, -- 'queued' | 'running' | 'completed' | 'failed'
        run_id      TEXT,
        error       TEXT,
        worker      TEXT,
        enqueued_at TEXT NOT NULL,
        started_at  TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_queue_status ON run_queue(status, enqueued_at);
    `,
  },
];

/** Apply every migration that has not yet run. Safe to call on every open. */
export function migrate(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => (r as { version: number }).version),
  );
  const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");

  const run = db.transaction((migrations: Migration[]) => {
    for (const m of migrations) {
      if (applied.has(m.version)) continue;
      db.exec(m.sql);
      record.run(m.version, new Date().toISOString());
    }
  });
  run(MIGRATIONS);
}
