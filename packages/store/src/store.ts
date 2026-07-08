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
import { defaultCipher, type SessionCipher } from "./crypto.js";
import { migrate } from "./schema.js";
import type {
  AuditEvent,
  AuditFilter,
  BrowserSessionRecord,
  ConfigEntry,
  ConnectorRecord,
  FlowRecord,
  RunStatus,
  RunView,
  StepRecord,
  StepView,
  StoredAuditEvent,
  ValidationRecord,
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

interface FlowRow {
  id: string;
  key: string;
  version: number;
  yaml: string;
  status: string;
  source: string;
  connector: string | null;
  created_at: string;
}

interface BrowserSessionRow {
  id: string;
  tenant: string;
  profile: string | null;
  cdp_endpoint: string | null;
  status: string;
  started_at: string;
  last_active_at: string;
  pid: number | null;
}

interface ConnectorRow {
  id: string;
  key: string;
  name: string;
  framework: string | null;
  base_url: string | null;
  auth: string | null;
  variables_json: string | null;
  created_at: string;
  updated_at: string;
}

interface ConfigRow {
  id: string;
  scope: string;
  category: string;
  key: string;
  value: string | null;
  secret: number;
  updated_at: string;
}

interface ValidationRow {
  id: string;
  flow_id: string;
  passed: number;
  reasons_json: string | null;
  run_id: string | null;
  created_at: string;
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
    this.cipher = opts.cipher ?? defaultCipher();
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

  // ---- flows --------------------------------------------------------------

  /** Insert a new flow version (self-serve portal). */
  saveFlow(f: {
    id: string;
    key: string;
    version: number;
    yaml: string;
    status: "draft" | "confirmed";
    source: "recorded" | "manual" | "llm";
    connector?: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO flows (id, key, version, yaml, status, source, connector, created_at)
         VALUES (@id, @key, @version, @yaml, @status, @source, @connector, @created_at)`,
      )
      .run({
        id: f.id,
        key: f.key,
        version: f.version,
        yaml: f.yaml,
        status: f.status,
        source: f.source,
        connector: f.connector ?? null,
        created_at: f.createdAt,
      });
  }

  /** Fetch a flow by id, or `undefined` if unknown. */
  getFlow(id: string): FlowRecord | undefined {
    const row = this.db.prepare("SELECT * FROM flows WHERE id = ?").get(id) as FlowRow | undefined;
    if (!row) return undefined;
    return this.hydrateFlow(row);
  }

  /** All versions of a flow key, newest version first. */
  listFlowVersions(key: string): FlowRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM flows WHERE key = ? ORDER BY version DESC")
      .all(key) as FlowRow[];
    return rows.map((r) => this.hydrateFlow(r));
  }

  /** Recent flows across all keys, newest first (for the drafts UI). */
  listFlows(limit = 50): FlowRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM flows ORDER BY created_at DESC LIMIT ?")
      .all(limit) as FlowRow[];
    return rows.map((r) => this.hydrateFlow(r));
  }

  /** Mark a flow version as confirmed. */
  confirmFlow(id: string): void {
    this.db.prepare("UPDATE flows SET status = 'confirmed' WHERE id = ?").run(id);
  }

  /** Highest-versioned confirmed flow for a key, or `undefined` if none is confirmed. */
  latestConfirmedFlow(key: string): FlowRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM flows WHERE key = @key AND status = 'confirmed'
         ORDER BY version DESC LIMIT 1`,
      )
      .get({ key }) as FlowRow | undefined;
    if (!row) return undefined;
    return this.hydrateFlow(row);
  }

  // ---- validations (draft dry-run outcomes that gate confirm) ----------

  /** Record a validation attempt (a dry-run outcome) for a flow draft. */
  recordValidation(v: { id: string; flowId: string; passed: boolean; reasons: string[]; runId?: string; createdAt: string }): void {
    this.db
      .prepare(
        `INSERT INTO validations (id, flow_id, passed, reasons_json, run_id, created_at)
         VALUES (@id, @flowId, @passed, @reasons, @runId, @createdAt)`,
      )
      .run({ ...v, passed: v.passed ? 1 : 0, reasons: JSON.stringify(v.reasons ?? []), runId: v.runId ?? null });
  }

  /** The most recent validation for a flow, or undefined if never validated. */
  latestValidation(flowId: string): ValidationRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM validations WHERE flow_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(flowId) as ValidationRow | undefined;
    return row ? this.hydrateValidation(row) : undefined;
  }

  private hydrateValidation(row: ValidationRow): ValidationRecord {
    const v: ValidationRecord = {
      id: row.id,
      flowId: row.flow_id,
      passed: row.passed === 1,
      reasons: row.reasons_json ? (JSON.parse(row.reasons_json) as string[]) : [],
      createdAt: row.created_at,
    };
    if (row.run_id != null) v.runId = row.run_id;
    return v;
  }

  private hydrateFlow(row: FlowRow): FlowRecord {
    const flow: FlowRecord = {
      id: row.id,
      key: row.key,
      version: row.version,
      yaml: row.yaml,
      status: row.status as FlowRecord["status"],
      source: row.source as FlowRecord["source"],
      createdAt: row.created_at,
    };
    if (row.connector != null) flow.connector = row.connector;
    return flow;
  }

  // ---- browser sessions -----------------------------------------------

  /** Register a newly-opened browser session (CDP session manager). */
  createBrowserSession(s: {
    id: string;
    tenant: string;
    profile?: string;
    cdpEndpoint?: string;
    startedAt: string;
    pid?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO browser_sessions
           (id, tenant, profile, cdp_endpoint, status, started_at, last_active_at, pid)
         VALUES
           (@id, @tenant, @profile, @cdp_endpoint, 'active', @started_at, @last_active_at, @pid)`,
      )
      .run({
        id: s.id,
        tenant: s.tenant,
        profile: s.profile ?? null,
        cdp_endpoint: s.cdpEndpoint ?? null,
        started_at: s.startedAt,
        last_active_at: s.startedAt,
        pid: s.pid ?? null,
      });
  }

  /** Bump a browser session's last-active timestamp. No-op if the session is unknown. */
  touchBrowserSession(id: string, at: string): void {
    this.db.prepare("UPDATE browser_sessions SET last_active_at = ? WHERE id = ?").run(at, id);
  }

  /** Record the OS pid of a browser session's process. No-op if the session is unknown. */
  setBrowserSessionPid(id: string, pid: number): void {
    this.db.prepare("UPDATE browser_sessions SET pid = ? WHERE id = ?").run(pid, id);
  }

  /** Mark a browser session closed. */
  closeBrowserSession(id: string, at: string): void {
    this.db
      .prepare("UPDATE browser_sessions SET status = 'closed', last_active_at = ? WHERE id = ?")
      .run(at, id);
  }

  /**
   * Browser sessions, active sessions first then by most-recently-active;
   * optionally filtered to a single tenant.
   */
  listBrowserSessions(tenant?: string): BrowserSessionRecord[] {
    const clause = tenant != null ? "WHERE tenant = @tenant" : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM browser_sessions ${clause}
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, last_active_at DESC`,
      )
      .all(tenant != null ? { tenant } : {}) as BrowserSessionRow[];
    return rows.map((r) => this.hydrateBrowserSession(r));
  }

  /** Fetch a browser session by id, or `undefined` if unknown. */
  getBrowserSession(id: string): BrowserSessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM browser_sessions WHERE id = ?")
      .get(id) as BrowserSessionRow | undefined;
    if (!row) return undefined;
    return this.hydrateBrowserSession(row);
  }

  private hydrateBrowserSession(row: BrowserSessionRow): BrowserSessionRecord {
    const session: BrowserSessionRecord = {
      id: row.id,
      tenant: row.tenant,
      status: row.status as BrowserSessionRecord["status"],
      startedAt: row.started_at,
      lastActiveAt: row.last_active_at,
    };
    if (row.profile != null) session.profile = row.profile;
    if (row.cdp_endpoint != null) session.cdpEndpoint = row.cdp_endpoint;
    if (row.pid != null) session.pid = row.pid;
    return session;
  }

  // ---- connectors --------------------------------------------------------

  /** Upsert a connector (by id) — the self-serve connector registry. */
  saveConnector(c: {
    id: string;
    key: string;
    name: string;
    framework?: string;
    baseUrl?: string;
    auth?: string;
    variables?: Record<string, string>;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO connectors (id, key, name, framework, base_url, auth, variables_json, created_at, updated_at)
         VALUES (@id, @key, @name, @framework, @base_url, @auth, @variables_json, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           key            = excluded.key,
           name           = excluded.name,
           framework      = excluded.framework,
           base_url       = excluded.base_url,
           auth           = excluded.auth,
           variables_json = excluded.variables_json,
           updated_at     = excluded.updated_at`,
      )
      .run({
        id: c.id,
        key: c.key,
        name: c.name,
        framework: c.framework ?? null,
        base_url: c.baseUrl ?? null,
        auth: c.auth ?? null,
        variables_json: JSON.stringify(c.variables ?? {}),
        created_at: c.createdAt,
        updated_at: c.updatedAt,
      });
  }

  /** Fetch a connector by id OR key, or `undefined` if unknown. */
  getConnector(idOrKey: string): ConnectorRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM connectors WHERE id = ? OR key = ?")
      .get(idOrKey, idOrKey) as ConnectorRow | undefined;
    if (!row) return undefined;
    return this.hydrateConnector(row);
  }

  /** All connectors, name ascending. */
  listConnectors(): ConnectorRecord[] {
    const rows = this.db.prepare("SELECT * FROM connectors ORDER BY name ASC").all() as ConnectorRow[];
    return rows.map((r) => this.hydrateConnector(r));
  }

  /** Delete a connector by id. */
  deleteConnector(id: string): void {
    this.db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
  }

  private hydrateConnector(row: ConnectorRow): ConnectorRecord {
    const connector: ConnectorRecord = {
      id: row.id,
      key: row.key,
      name: row.name,
      variables: row.variables_json ? (JSON.parse(row.variables_json) as Record<string, string>) : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.framework != null) connector.framework = row.framework;
    if (row.base_url != null) connector.baseUrl = row.base_url;
    if (row.auth != null) connector.auth = row.auth;
    return connector;
  }

  // ---- app config (LLM settings + connector variables) ------------------

  /**
   * Upsert a config entry keyed by (scope, category, key). Secret values are
   * written through the session cipher — the same seam `sessions.storage_state`
   * uses — so they are never stored in plaintext.
   */
  setConfig(e: { scope: string; category: "llm" | "variable"; key: string; value: string; secret?: boolean }): void {
    const id = `cfg_${e.scope}_${e.category}_${e.key}`;
    const secret = e.secret ?? false;
    this.db
      .prepare(
        `INSERT INTO app_config (id, scope, category, key, value, secret, updated_at)
         VALUES (@id, @scope, @category, @key, @value, @secret, @updated_at)
         ON CONFLICT(scope, category, key) DO UPDATE SET
           value      = excluded.value,
           secret     = excluded.secret,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        scope: e.scope,
        category: e.category,
        key: e.key,
        value: secret ? this.cipher.encrypt(e.value) : e.value,
        secret: secret ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
  }

  /** Config entries for a scope (optionally filtered to a category), decrypted. */
  getConfig(scope: string, category?: "llm" | "variable"): ConfigEntry[] {
    const clause = category != null ? "AND category = @category" : "";
    const rows = this.db
      .prepare(`SELECT * FROM app_config WHERE scope = @scope ${clause} ORDER BY key ASC`)
      .all(category != null ? { scope, category } : { scope }) as ConfigRow[];
    return rows.map((r) => this.hydrateConfig(r));
  }

  /** A single decrypted config value, or `undefined` if unset. */
  getConfigValue(scope: string, category: "llm" | "variable", key: string): string | undefined {
    const row = this.db
      .prepare("SELECT * FROM app_config WHERE scope = ? AND category = ? AND key = ?")
      .get(scope, category, key) as ConfigRow | undefined;
    if (!row) return undefined;
    return this.hydrateConfig(row).value;
  }

  /** Delete a config entry. */
  deleteConfig(scope: string, category: "llm" | "variable", key: string): void {
    this.db.prepare("DELETE FROM app_config WHERE scope = ? AND category = ? AND key = ?").run(scope, category, key);
  }

  private hydrateConfig(row: ConfigRow): ConfigEntry {
    const value = row.value == null ? "" : row.secret === 1 ? this.cipher.decrypt(row.value) : row.value;
    return {
      id: row.id,
      scope: row.scope,
      category: row.category as ConfigEntry["category"],
      key: row.key,
      value,
      secret: row.secret === 1,
      updatedAt: row.updated_at,
    };
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
