/**
 * @portico/store — durable persistence + auditability.
 *
 * Public surface:
 *   - `Store`            repository (runs, steps, sessions, audit, artifacts)
 *   - `Artifacts`        standalone local artifact helper
 *   - `SessionCipher`    at-rest codec seam for session storage_state
 *   - `base64Cipher`     default (placeholder) codec — see crypto.ts TODO
 *   - view/record types  matching the platform's RunView / StepView shapes
 *
 * NOTE: audit is append-only — only `appendAudit` + `listAudit` are exported;
 * there is intentionally no update/delete for audit records anywhere.
 */

export { Store } from "./store.js";
export type { StoreOptions } from "./store.js";
export { Artifacts } from "./artifacts.js";
export { base64Cipher } from "./crypto.js";
export type { SessionCipher } from "./crypto.js";
export type {
  AuditEvent,
  AuditFilter,
  RunMode,
  RunStatus,
  RunView,
  StepRecord,
  StepStatus,
  StepView,
  StoredAuditEvent,
  Tier,
} from "./types.js";
