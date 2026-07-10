/**
 * Authoring-quality eval: scores the two-source reconciliation (agent action
 * stream × DOM click-hook stream, see ../agent-actions.ts) over saved capture
 * fixtures. Pure functions only — no browser, no network, no filesystem — so
 * this runs identically locally and in CI and catches a reconciliation/locator
 * regression automatically instead of requiring a human to eyeball a run.
 *
 * The regression this guards against (observed in live authoring runs): for
 * each real control, the DOM click hook can fire TWICE — once on the exact
 * node (a clean, short accessible name) and once mis-resolved to a page-level
 * container or root (`/html[1]`, or the `<main>` landmark with `id="main"`),
 * whose captured text is a long concatenation of unrelated sibling text. The
 * agent's OWN resolved xpath always equals the clean node's, never the
 * blob's, so a correct reconciliation must:
 *   1. bind every reconciled step to the clean node's real accessible name
 *      (never the blob's text, never an un-cleaned LLM paraphrase),
 *   2. never cache a step's locator to a generic container id (`#main`, …),
 *   3. drop every hook click the agent never corroborated as noise.
 */
import type { ClickEvent } from "@portico/flow-spec";
import { extractAgentActions, reconcileClicks, labelOfClick } from "../agent-actions.js";

/**
 * A saved authoring-run capture, reduced to exactly the two reconcile inputs
 * (mirrors the shape of `data/author-evidence-latest.json`'s `rawClicks` +
 * `actions` fields), plus the ground truth a correct reconciliation must
 * reproduce.
 */
export interface CaptureFixture {
  /** Short, stable id for reports and test output. */
  name: string;
  /** One-line description of what this fixture stresses. */
  description: string;
  /** Every raw DOM click the hook captured, before reconciliation — the
   *  first argument to `reconcileClicks` (evidence.rawClicks shape). */
  rawClicks: ClickEvent[];
  /** The raw Stagehand `AgentResult.actions` stream, BEFORE distillation —
   *  the argument to `extractAgentActions` (evidence.actions shape). Loosely
   *  typed on purpose: this is exactly what Stagehand hands us at runtime. */
  agentActions: unknown[];
  /**
   * Ground truth: the real DOM accessible names, in the order a correct
   * reconciliation must emit them as step names. A reconciled step whose name
   * is anything else (a blob's concatenated text, an un-cleaned LLM
   * paraphrase) counts against `cleanNameRate`.
   */
  expectedNames: string[];
}

export type Confidence = "high" | "medium" | "low";

/** Ids that name a page-level layout landmark rather than a specific control.
 *  A reconciled step cached to one of these means a container blob's identity
 *  leaked through instead of the real control's — always a regression. */
const GENERIC_CONTAINER_IDS = new Set(["main", "root", "app", "content", "wrapper", "container", "page"]);

function isGenericContainerId(id: string | null | undefined): boolean {
  return !!id && GENERIC_CONTAINER_IDS.has(id.trim().toLowerCase());
}

/**
 * A real control's accessible name is concise; a container/notification
 * mis-capture's is a long blob of concatenated inner text. Mirrors the
 * compiler's `MAX_CONTROL_LABEL` threshold (packages/author/src/index.ts) —
 * duplicated here (not imported) since that constant isn't exported and this
 * eval must stay a read-only observer of the author package's public API.
 */
const BLOB_LABEL_THRESHOLD = 72;

export interface FixtureReport {
  /** The fixture's `name`, carried through for readable output. */
  fixture: string;
  /** Whether reconciliation used the agent stream (false ⇒ fell back to raw
   *  hook clicks — itself a signal worth failing a test on for these fixtures). */
  usedAgentStream: boolean;
  /** Number of reconciled replay steps. */
  stepCount: number;
  /** Reconciled step names (ariaLabel ?? text ?? name ?? testid), in order. */
  stepNames: string[];
  /** Fraction of reconciled steps whose name exactly equals one of the
   *  fixture's declared ground-truth accessible names. 1 = perfect. */
  cleanNameRate: number;
  /** Count of reconciled steps cached to a generic container id (e.g. "main").
   *  Must be 0 — this is the container-blob-identity regression. */
  containerIdCacheCount: number;
  /** Hook clicks the reconciler dropped as noise (`ReconcileResult.droppedNoise`). */
  noiseDropped: number;
  /** Reconciled steps whose resolved name is itself blob-length (> 72 chars).
   *  Should be 0 independent of `expectedNames` (a structural, not ground-
   *  truth-relative, signal). */
  blobLeakCount: number;
  /** Distribution of per-step reconciliation confidence. */
  confidence: Record<Confidence, number>;
}

function emptyConfidence(): Record<Confidence, number> {
  return { high: 0, medium: 0, low: 0 };
}

/**
 * Reconcile one fixture (extractAgentActions → reconcileClicks) and compute
 * its quality report. Pure — no I/O, safe to run in CI on every commit.
 */
export function scoreFixture(fixture: CaptureFixture): FixtureReport {
  const agentActs = extractAgentActions(fixture.agentActions);
  const result = reconcileClicks(fixture.rawClicks, agentActs);

  const expected = new Set(fixture.expectedNames.map((n) => n.trim()));

  const stepNames: string[] = [];
  let cleanMatches = 0;
  let containerIdCacheCount = 0;
  let blobLeakCount = 0;
  for (const step of result.steps) {
    const name = labelOfClick(step);
    stepNames.push(name);
    if (expected.has(name)) cleanMatches++;
    if (isGenericContainerId(step.id)) containerIdCacheCount++;
    if (name.length > BLOB_LABEL_THRESHOLD) blobLeakCount++;
  }

  const confidence = emptyConfidence();
  for (const m of result.meta) confidence[m.confidence]++;

  const cleanNameRate =
    stepNames.length === 0 ? (fixture.expectedNames.length === 0 ? 1 : 0) : cleanMatches / stepNames.length;

  return {
    fixture: fixture.name,
    usedAgentStream: result.usedAgentStream,
    stepCount: result.steps.length,
    stepNames,
    cleanNameRate,
    containerIdCacheCount,
    noiseDropped: result.droppedNoise,
    blobLeakCount,
    confidence,
  };
}

/** Convenience batch runner over several fixtures (e.g. all of `fixtures/`). */
export function scoreFixtures(fixtures: readonly CaptureFixture[]): FixtureReport[] {
  return fixtures.map(scoreFixture);
}
