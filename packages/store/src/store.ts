/**
 * @portico/store — durable persistence + append-only audit for the platform.
 *
 * Backed by better-sqlite3 (synchronous, zero-ops) for the pilot; the schema
 * and repository API are deliberately Postgres-shaped so this can be swapped
 * for a networked store later without touching callers.
 *
 * The repository maps cleanly to/from the platform view types: `createRun`,
 * `getRun`, and `listRuns` speak `RunView`; `addRunSteps` speaks `StepView`.
 * `audit_events` is append-only — only `appendAudit` + `listAudit` are exposed.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Artifacts } from "./artifacts.js";
import { base64Cipher, type SessionCipher } from "./crypto.js";
import { migrate } from "./schema.js";
import type {
  AuditEvent,
  AuditFilter,
  RunStatus,
  RunView,
  StepRecord,
  StepView,
  StoredAuditEvent,
} from "./types.js";

export interface StoreOptions {
  /** SQLite file path. Defaults to "data/portico.db". */
  dbPath?: string;
  /** Data root for artifacts (rrweb/screenshots). Defaults to dirname(dbPath). */
  dataDir?: string;
  /** Pluggable at-rest codec for session storage_state. Defaults to base64. */
  cipher?: SessionCipher;
}

const DEFAULT_DB_PATH = "data/portico.db";
const DEFAULT_LIST_LIMIT = 50;

interface RunRow {
  id: string;
  connector: string;
  flow: string;
  engine: string;
  tier: string;
  status: string;
  mode: string;
  started_at: string;
  duration_ms: number;
  output_json: string | null;
  failure_json: string | null;
  rrweb_ref: string | null;
  created_at: string;
}

interface StepRow {
  idx: number;
  type: string;
  label: string | null;
  status: string;
  detail: string | null;
  healed_from: string | null;
  healed_to: string | null;
  screenshot_ref: string | null;
  duration_ms: number;
}

export class Store {
  private readonly db: Database.Database;
  private readonly cipher: SessionCipher;
  private readonly artifacts: Artifacts;

  constructor(opts: StoreOptions = {}) {
    const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
    const dataDir = opts.dataDir ?? dirname(dbPath);
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    migrate(this.db);
    this.cipher = opts.cipher ?? base64Cipher;
    this.artifacts = new Artifacts(dataDir);
  }

  /** Close the underlying database handle. */
  close(): void {
    this.db.close();
  }

  // ---- runs -------------------------------------------------------------

  /** Insert a run (and any steps it already carries) from a `RunView`. */
  createRun(run: RunView): void {
    const insert = this.db.transaction((r: RunView) => {
      this.db
        .prepare(
          `INSERT INTO runs
             (id, connector, flow, engine, tier, status, mode,
              started_at, duration_ms, output_json, failure_json, rrweb_ref, created_at)
           VALUES
             (@id, @connector, @flow, @engine, @tier, @status, @mode,
              @started_at, @duration_ms, @output_json, @failure_json, @rrweb_ref, @created_at)`,
        )
        .run({
          id: r.id,
          connector: r.connector,
          flow: r.flow,
          engine: r.engine,
          tier: r.tier,
          status: r.status,
          mode: r.mode,
          started_at: r.startedAt,
          duration_ms: r.durationMs,
          output_json: r.output ? JSON.stringify(r.output) : null,
          failure_json: r.failure ? JSON.stringify(r.failure) : null,
          rrweb_ref: null,
          created_at: new Date().toISOString(),
        });
      if (r.steps?.length) this.insertSteps(r.id, r.steps);
    });
    insert(run);
  }

  /** Patch a run's terminal fields (status/duration/output/failure/rrweb). */
  updateRunStatus(
    id: string,
    status: RunStatus,
    durationMs: number,
    output?: Record<string, unknown>,
    failure?: { stepIndex: number; reason: string },
    rrwebRef?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE runs
            SET status = @status,
                duration_ms = @duration_ms,
                output_json = @output_json,
                failure_json = @failure_json,
                rrweb_ref = COALESCE(@rrweb_ref, rrweb_ref)
          WHERE id = @id`,
      )
      .run({
        id,
        status,
        duration_ms: durationMs,
        output_json: output ? JSON.stringify(output) : null,
        failure_json: failure ? JSON.stringify(failure) : null,
        rrweb_ref: rrwebRef ?? null,
      });
  }

  /** Append steps to a run. Accepts `StepView` (or `StepRecord` with heal info). */
  addRunSteps(runId: string, steps: StepView[]): void {
    const insert = this.db.transaction((rows: StepView[]) => this.insertSteps(runId, rows));
    insert(steps);
  }

  private insertSteps(runId: string, steps: StepView[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO run_steps
         (run_id, idx, type, label, status, detail, healed_from, healed_to, screenshot_ref, duration_ms)
       VALUES
         (@run_id, @idx, @type, @label, @status, @detail, @healed_from, @healed_to, @screenshot_ref, @duration_ms)`,
    );
    for (const s of steps) {
      const rec = s as StepRecord;
      stmt.run({
        run_id: runId,
        idx: s.index,
        type: s.type,
        label: s.label ?? null,
        status: s.status,
        detail: s.detail ?? null,
        healed_from: rec.healedFrom ?? null,
        healed_to: rec.healedTo ?? null,
        screenshot_ref: rec.screenshotRef ?? null,
        duration_ms: s.durationMs,
      });
    }
  }

  /** Fetch a run as a fully-hydrated `RunView`, or `undefined` if unknown. */
  getRun(id: string): RunView | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) return undefined;
    return this.hydrateRun(row);
  }

  /** Most recent runs first, hydrated as `RunView`s. */
  listRuns(limit: number = DEFAULT_LIST_LIMIT): RunView[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as RunRow[];
    return rows.map((r) => this.hydrateRun(r));
  }

  private hydrateRun(row: RunRow): RunView {
    const stepRows = this.db
      .prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx ASC")
      .all(row.id) as StepRow[];
    const steps: StepRecord[] = stepRows.map((s) => ({
      index: s.idx,
      type: s.type,
      ...(s.label != null ? { label: s.label } : {}),
      status: s.status as StepView["status"],
      ...(s.detail != null ? { detail: s.detail } : {}),
      ...(s.healed_from != null ? { healedFrom: s.healed_from } : {}),
      ...(s.healed_to != null ? { healedTo: s.healed_to } : {}),
      ...(s.screenshot_ref != null ? { screenshotRef: s.screenshot_ref } : {}),
      durationMs: s.duration_ms,
    }));
    const run: RunView = {
      id: row.id,
      connector: row.connector,
      flow: row.flow,
      engine: row.engine,
      tier: row.tier as RunView["tier"],
      status: row.status as RunView["status"],
      mode: row.mode as RunView["mode"],
      startedAt: row.started_at,
      durationMs: row.duration_ms,
      steps,
    };
    if (row.output_json) run.output = JSON.parse(row.output_json);
    if (row.failure_json) run.failure = JSON.parse(row.failure_json);
    if (row.rrweb_ref) run.rrwebRef = row.rrweb_ref;
    return run;
  }

  // ---- sessions ---------------------------------------------------------

  /**
   * Persist a trusted-device `storage_state` for (tenant, credential). The
   * value is written through the session cipher and is never logged.
   */
  saveSession(tenant: string, credential: string, storageState: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (tenant, credential, storage_state, updated_at)
         VALUES (@tenant, @credential, @storage_state, @updated_at)
         ON CONFLICT(tenant, credential)
         DO UPDATE SET storage_state = excluded.storage_state,
                       updated_at = excluded.updated_at`,
      )
      .run({
        tenant,
        credential,
        storage_state: this.cipher.encrypt(storageState),
        updated_at: new Date().toISOString(),
      });
  }

  /** Read back and decrypt a session's `storage_state`, or `undefined`. */
  getSession(tenant: string, credential: string): string | undefined {
    const row = this.db
      .prepare("SELECT storage_state FROM sessions WHERE tenant = ? AND credential = ?")
      .get(tenant, credential) as { storage_state: string } | undefined;
    if (!row) return undefined;
    return this.cipher.decrypt(row.storage_state);
  }

  // ---- audit (APPEND-ONLY) ---------------------------------------------

  /** Append an immutable audit record. There is no update/delete counterpart. */
  appendAudit(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (ts, actor, action, run_id, target, detail_json)
         VALUES (@ts, @actor, @action, @run_id, @target, @detail_json)`,
      )
      .run({
        ts: event.ts ?? new Date().toISOString(),
        actor: event.actor,
        action: event.action,
        run_id: event.runId ?? null,
        target: event.target ?? null,
        detail_json: event.detail ? JSON.stringify(event.detail) : null,
      });
  }

  /** List audit records (newest first), optionally filtered. */
  listAudit(filter: AuditFilter = {}): StoredAuditEvent[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.runId != null) {
      where.push("run_id = @runId");
      params.runId = filter.runId;
    }
    if (filter.actor != null) {
      where.push("actor = @actor");
      params.actor = filter.actor;
    }
    if (filter.action != null) {
      where.push("action = @action");
      params.action = filter.action;
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? DEFAULT_LIST_LIMIT;
    const rows = this.db
      .prepare(`SELECT * FROM audit_events ${clause} ORDER BY id DESC LIMIT @limit`)
      .all({ ...params, limit }) as Array<{
      id: number;
      ts: string;
      actor: string;
      action: string;
      run_id: string | null;
      target: string | null;
      detail_json: string | null;
    }>;
    return rows.map((r) => {
      const e: StoredAuditEvent = { id: r.id, ts: r.ts, actor: r.actor, action: r.action };
      if (r.run_id != null) e.runId = r.run_id;
      if (r.target != null) e.target = r.target;
      if (r.detail_json != null) e.detail = JSON.parse(r.detail_json);
      return e;
    });
  }

  // ---- artifacts --------------------------------------------------------

  /** Persist an artifact (rrweb/screenshot/etc.); returns a data-root-relative ref. */
  saveArtifact(data: Uint8Array | string, ext: string): string {
    return this.artifacts.saveArtifact(data, ext);
  }

  /** Resolve an artifact ref to an absolute path. */
  getArtifactPath(ref: string): string {
    return this.artifacts.getArtifactPath(ref);
  }
}
