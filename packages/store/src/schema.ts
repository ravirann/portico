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
