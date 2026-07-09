/**
 * @portico/author — agent-authored deterministic flows.
 *
 * The reliability thesis (see docs/REBUILD-PROPOSAL.md §2): an LLM browser agent
 * is the wrong RUNTIME (65–89% success, per-run cost, unauditable) but the right
 * AUTHOR. It generalizes to a novel portal the way hand-written compiler
 * heuristics never will. So we let Stagehand drive the portal toward a stated
 * goal ONCE, capture what it actually did (the final URL it reached + the JSON
 * API responses that fired), and FREEZE that into a deterministic Portico flow
 * — which then replays with zero model calls, fully audited, in ~600ms.
 *
 * Agent authors once (and re-heals on drift); the frozen flow runs forever.
 *
 * This module is intentionally isolated from @portico/engine: Stagehand pins
 * `ai@^5` (engine is on `ai@^6`) and bundles its own browser drivers, so it must
 * not leak into the deterministic runtime's dependency graph.
 */

import { Stagehand } from "@browserbasehq/stagehand";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import type { Flow, Step, ClickEvent, NetworkEntry } from "@portico/flow-spec";
import { compileRecording } from "@portico/flow-spec";
import { rewriteGoal, countPlanSteps, type GoalPlan, type GoalParameter } from "./rewrite.js";
import { extractAgentActions, reconcileClicks, type AgentActionRecord, type ReconcileMeta } from "./agent-actions.js";

export { rewriteGoal, normalizePlan, countPlanSteps } from "./rewrite.js";
export type { GoalPlan, GoalParameter } from "./rewrite.js";

export interface AuthorOptions {
  /** Plain-language goal, e.g. "open claim 4305's detail and show its workflow steps". */
  goal: string;
  /** CDP endpoint of an already-logged-in browser (reuses the session). */
  cdpUrl: string;
  /** Where to start before the agent runs (the portal's list page). */
  startUrl: string;
  /** Model, e.g. "openai/gpt-5.5". */
  model: string;
  apiKey: string;
  /** Flow key for the compiled artifact. Default "authored-flow". */
  key?: string;
  /**
   * Floor for the agent's step budget. Default 12, but the effective budget
   * is always at least this AND a higher intent/goal-length-based floor (see
   * authorFlow) — set this only to raise the budget further, e.g. for an
   * unusually long SOP.
   */
  maxSteps?: number;
  /** Emit progress lines. */
  onLog?: (line: string) => void;
}

/** A JSON API response the agent's actions caused the page to make. */
interface HarvestedResponse {
  url: string;
  pathname: string;
  bytes: number;
  contentType: string;
}

/**
 * A request the agent caused — captured with its body so a mutation (POST/PUT/
 * PATCH/DELETE) or a search (POST with a query body) can be frozen into a
 * deterministic `api` step, not just harvested as a read.
 */
export interface CapturedRequest {
  method: string;
  url: string;
  pathname: string;
  resourceType: string;
  /** Raw request body, if any (JSON string for most API calls). */
  postData?: string;
  /** Request headers — needed to replicate an authenticated mutation. */
  headers?: Record<string, string>;
}

export interface AuthorResult {
  flow: Flow;
  /** What the agent did, for the audit trail / review UI. */
  evidence: {
    goal: string;
    finalUrl: string;
    agentSuccess: boolean;
    agentMessage: string;
    /** Raw Stagehand agent action stream (opaque, for full-fidelity audit). */
    actions: unknown[];
    /** The agent's own deliberate interactions, distilled (intent + xpath). */
    agentActions: AgentActionRecord[];
    /** Every raw DOM click the hook captured, before reconciliation (diagnostics). */
    rawClicks: ClickEvent[];
    /** How the two capture streams were merged into the replayed steps. */
    reconciliation: {
      usedAgentStream: boolean;
      steps: number;
      droppedNoise: number;
      meta: ReconcileMeta[];
      compiledSteps: Array<{ text?: string | null; role?: string | null; id?: string | null; testid?: string | null; xpath?: string | null }>;
    };
    dataEndpoints: string[];
    /** Search/mutation requests captured with bodies (for write-flow authoring). */
    writeRequests: CapturedRequest[];
    /** The rewriter's structured plan of the goal. */
    plan: GoalPlan;
  };
}

const log = (opts: AuthorOptions, s: string) => opts.onLog?.(s);

/** Page title / URL that reads as a sign-in screen (portal-agnostic). */
const LOGIN_TITLE_RE = /\b(log[\s-]?in|sign[\s-]?in|logon|log[\s-]?on|authenticate|single sign|sso)\b/i;
const LOGIN_URL_RE = /\/(login|log-in|signin|sign-in|logon|log-on|auth|sso|oauth|prelogin|account\/login)\b/i;
/** Requests that only fire in a pre-login / guest funnel (Epic's Anonymous /
 *  LoadForPrelogin / OpenScheduling, and the generic prelogin/guest paths). */
const PRELOGIN_REQUEST_RE = /\/(anonymous|prelogin|loadforprelogin|openscheduling|guest)\b/i;
/**
 * Requests that only fire ON or AROUND a sign-in / pre-login screen — the login
 * widget, passkey/MFA params, the prelogin proxy switch. Matched as a substring
 * (NOT slash-anchored) so vendor-cased names like "LoadForPrelogin" and
 * "GetPasskeyGetParams" are caught generically without hardcoding one portal's
 * exact route. If ANY of these fired during a run, the session dropped to the
 * login flow — it was never authenticated — which is a decisive auth-wall signal
 * on its own (unlike the softer "guest funnel" paths above).
 */
const LOGIN_API_RE =
  /(authentication\/login|prelogin|loadforprelogin|passkey|two[-_ ]?factor|multi[-_ ]?factor|\/login\b|\/signin\b|\/sso\b|\/oauth\b)/i;

/**
 * Decide whether the agent finished on a NOT-LOGGED-IN state — a sign-in wall or
 * a pre-login/guest funnel — rather than inside the authenticated portal. This
 * is the precondition gate: if the attached session isn't authenticated, the
 * captured run is worthless (it froze the login page / guest funnel), so
 * authoring must fail LOUDLY with an actionable message instead of compiling a
 * dead flow that only fails later at validation.
 *
 * Kept pure (no browser) so it's unit-tested; `authorFlow` supplies the DOM
 * signal. Conservative by design — a lone password field mid-flow (e.g. a
 * change-password step) won't trip it; the signals must corroborate.
 */
/**
 * Whether `authorFlow` should navigate the attached tab to the start URL.
 *
 * The human logs into the portal in the live session and parks on an
 * authenticated page (e.g. .../MyChart/Home). Force-navigating that tab to the
 * start URL — especially a BARE ROOT — can DESTROY the session: some portals
 * (Epic MyChart, verified) clear their auth cookies when you hit the marketing
 * root, silently logging you out before the agent even starts. So when the tab
 * is already on the start URL's ORIGIN, keep it and let the agent navigate
 * within the app; only navigate from a blank/new tab or a different origin.
 *
 * Pure and unit-tested; the browser-facing call sits in authorFlow.
 */
export function shouldNavigateToStart(currentUrl: string | undefined, startUrl: string): boolean {
  let startOrigin: string;
  try {
    startOrigin = new URL(startUrl).origin;
  } catch {
    return true; // can't parse the target — fall back to navigating
  }
  const cur = (currentUrl ?? "").trim();
  // A blank / internal page means the session hasn't landed anywhere yet.
  if (!cur || cur === "about:blank" || /^(chrome|chrome-error|edge|about):/i.test(cur)) return true;
  let curOrigin: string;
  try {
    curOrigin = new URL(cur).origin;
  } catch {
    return true;
  }
  // Same origin → the human is already in the portal; don't risk a destructive
  // (or session-dropping) navigation. Different origin → we must go there.
  return curOrigin !== startOrigin;
}

export function detectAuthWall(input: {
  finalUrl: string;
  title: string;
  hasPasswordField: boolean;
  requests: Array<{ pathname: string }>;
}): { blocked: boolean; reason: string } {
  const titleLogin = LOGIN_TITLE_RE.test(input.title ?? "");
  const urlLogin = LOGIN_URL_RE.test(input.finalUrl ?? "");
  const reqs = input.requests ?? [];
  const preloginHits = reqs.filter((r) => PRELOGIN_REQUEST_RE.test(r.pathname)).length;
  // Login/auth-widget calls are the decisive signal: if the sign-in flow ran at
  // all, the session was not authenticated — no need to corroborate.
  const loginApiHits = reqs.filter((r) => LOGIN_API_RE.test(r.pathname)).length;

  // Block when: the login/auth flow ran (decisive on its own); OR a visible
  // password field is corroborated by a login-ish title/URL or a pre-login
  // funnel; OR a login title AND login URL together (SPA login whose password
  // hides behind a "Sign in" button); OR a pre-login funnel on a login page.
  const blocked =
    loginApiHits > 0 ||
    (input.hasPasswordField && (titleLogin || urlLogin || preloginHits > 0)) ||
    (titleLogin && urlLogin) ||
    (preloginHits > 0 && (titleLogin || urlLogin));
  if (!blocked) return { blocked: false, reason: "" };

  const where = `"${input.title || "untitled"}" at ${input.finalUrl}`;
  const detail =
    loginApiHits > 0
      ? ` The run passed through the sign-in / pre-login flow (${loginApiHits} auth request${loginApiHits === 1 ? "" : "s"}), so it never reached an authenticated session.`
      : preloginHits > 0
        ? ` The agent only reached pre-login endpoints (${preloginHits} guest/anonymous request${preloginHits === 1 ? "" : "s"}).`
        : "";
  return {
    blocked: true,
    reason:
      `The attached browser session isn't logged in — it ended on / passed through a sign-in screen (${where}).${detail} ` +
      `Finish signing into the portal in that session's window (Sessions page) until you see the account dashboard, leave it open, then re-author.`,
  };
}

/**
 * Stagehand's CDP client needs the browser-level WebSocket debugger URL, while
 * Playwright's connectOverCDP accepts the HTTP endpoint. Given either, resolve
 * the ws:// URL via /json/version. Passes ws:// through unchanged.
 */
async function resolveCdpWsUrl(cdpUrl: string): Promise<string> {
  if (cdpUrl.startsWith("ws://") || cdpUrl.startsWith("wss://")) return cdpUrl;
  const base = cdpUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json/version`);
  const info = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) throw new Error(`no webSocketDebuggerUrl at ${base}/json/version`);
  return info.webSocketDebuggerUrl;
}

/** Path portion of a URL, tolerant of relative/malformed input. */
function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** Numeric id values that appear in a URL's query string (e.g. 4299 from ?claimId=4299). */
export function idsInUrl(url: string): string[] {
  try {
    const u = new URL(url);
    return [...u.searchParams.values()].filter((v) => /^\d+$/.test(v));
  } catch {
    return [];
  }
}

/**
 * A stable substring of `pathname` that omits any per-record numeric id but
 * still literally occurs in the live URL (so an intercept `url_contains` match
 * fires on every run, whatever the id). Prefers the segment(s) after the id.
 */
export function idFreeMatch(pathname: string): string {
  const after = pathname.match(/\/\d+\/(.+)$/); // /api/.../claims/4305/notes → notes
  if (after) return `/${after[1]}`;
  const before = pathname.match(/^(.*?)\/\d+$/); // /api/.../claims/4305 → /api/.../claims
  if (before) return before[1]!;
  return pathname; // no id in the path — a plain list endpoint
}

/** A JSON XHR/fetch response worth harvesting (2xx, json-ish). */
function isDataResponse(status: number, contentType: string, resourceType: string): boolean {
  if (status < 200 || status >= 300) return false;
  const ct = contentType.toLowerCase();
  if (!ct.includes("json") && !ct.includes("graphql")) return false;
  return resourceType === "xhr" || resourceType === "fetch";
}

/**
 * Turn a concrete URL the agent landed on into a templated `navigate` URL plus
 * the inputs it implies: any numeric query param (…?claimId=4305) becomes a
 * flow input ({{claim_id}}). This is the generalizable "opening a detail page
 * is a URL, not a fragile row-click" rule — learned from the URL, not guessed
 * from click text.
 */
function parameterizeUrl(
  finalUrl: string,
  planParams: GoalParameter[] = [],
): { url: string; inputs: Record<string, string> } {
  const inputs: Record<string, string> = {};
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return { url: finalUrl, inputs };
  }
  const planByValue = planParams.filter((p) => p.value);
  for (const [k, v] of [...u.searchParams.entries()]) {
    // A query value the rewriter named (e.g. a search term "playwright") is a
    // per-run input regardless of type — this is what makes non-numeric
    // deep-link searches reusable, not just id-shaped params.
    const plan = planByValue.find((p) => v.includes(p.value));
    if (plan) {
      inputs[plan.name] = `string — e.g. ${v}`;
      u.searchParams.set(k, v.replace(plan.value, `{{${plan.name}}}`));
      continue;
    }
    // Else a stable id-shaped param (all digits) is the per-run value.
    if (/^\d+$/.test(v)) {
      const inputName = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(); // claimId → claim_id
      inputs[inputName] = `string — e.g. ${v}`;
      u.searchParams.set(k, `{{${inputName}}}`);
    }
  }
  // URL-encoding turns {{ }} into %7B%7B…; decode just those back so the
  // engine's template pass sees real {{name}} markers.
  const url = u.toString().replace(/%7B%7B/gi, "{{").replace(/%7D%7D/gi, "}}");
  return { url, inputs };
}

/**
 * Compile the agent's run into a deterministic harvest flow:
 *   intercept(data endpoints) → navigate(parameterized final URL) → wait.
 * Picks the JSON endpoints that carry the most data, strips any per-record id
 * out of the intercept match (so it matches on every run), and parameterizes
 * the final URL's id params into flow inputs.
 */
/**
 * Infrastructure/boot endpoints every page loads — permissions, feature flags,
 * auth/session, telemetry. Never the data a flow is authored to harvest.
 */
// ONLY generic infrastructure/telemetry — never domain entities. (An earlier
// version listed pulse-specific nouns like "tickets"/"clinics", which wrongly
// dropped real data endpoints on other portals. Keep this domain-agnostic.)
const BOOT_NOISE_RE =
  /\/(permissions|feature-?flags|flags|userinfo|analytics|telemetry|collect|faro|rum|metrics|beacon|events|healthz?|heartbeat|ping|config)\b/i;

// Non-GET requests a page fires on its own (session/heartbeat/telemetry POSTs)
// that must never be mistaken for a user's intended mutation.
const MUTATION_NOISE_RE = /\/(session|heartbeat|keep-?alive|track|collect|beacon|analytics|telemetry|log|events?|refresh)\b/i;

/** Collapse duplicate captured requests (agents retry) by method+path+body. */
export function dedupeRequests(requests: CapturedRequest[]): CapturedRequest[] {
  const seen = new Map<string, CapturedRequest>();
  for (const r of requests) {
    if (BOOT_NOISE_RE.test(r.pathname)) continue;
    seen.set(`${r.method} ${r.pathname} ${r.postData ?? ""}`, r);
  }
  return [...seen.values()];
}

/**
 * Per-run VALUE tokens named in the goal — the things a reusable flow must
 * parameterize. Digit runs (phone/ids ≥5 digits) are the reliable signal; a
 * request carrying one of these is acting on the goal's specific record.
 */
export function goalTokens(goal: string): string[] {
  return [...new Set((goal.match(/\d{5,}/g) ?? []))];
}

/** camelCase / kebab query key → snake_case input name (phoneNumber → phone_number). */
function inputNameFor(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-\s]+/g, "_").toLowerCase();
}

/** Peripheral third-party integrations customer-lens fans out to — chat, call
 *  logs, workflow webhooks. Not the primary record a search/update acts on. */
const INTEGRATION_NOISE_RE = /\/(chat|kaleyra|n8n|webhook|conversations|whatsapp|zoko|freshdesk)\b/i;

/** A phone-shaped token (10–13 digits) maps to one canonical input, so the same
 *  number in three different query params doesn't spawn three inputs. */
function canonicalInputName(token: string, queryKey: string): string {
  return /^\d{10,13}$/.test(token) ? "phone_number" : inputNameFor(queryKey);
}

/** Last path segment, singularized, as an output key (customers → customer). */
function outputKeyFor(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "result";
  return seg.replace(/s$/, "") || "result";
}

/** An `api`-tier step, when a step's body carries an `api` block. */
interface ApiBlock {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: "json";
  responseType?: "json" | "text";
}

/** A localStorage key whose value equals `value`, else null. Used to discover
 *  where an auth/tenant header value lives so the write can read it fresh. */
function localStorageKeyForValue(value: string, ls: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(ls)) if (v === value) return k;
  return null;
}

/** Dotted path to `value` within `obj` (e.g. "family.id"), or null if absent. */
function findJsonPath(obj: unknown, value: string, prefix = ""): string | null {
  if (obj == null || typeof obj !== "object") {
    return String(obj) === value ? prefix.replace(/^\./, "") : null;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const hit = findJsonPath(v, value, `${prefix}.${k}`);
    if (hit != null) return hit;
  }
  return null;
}

/**
 * A `{{lookupKey.path}}` reference if `value` is found in a prior lookup's
 * response — so a mutation URL's ids chain off the search result (the update
 * URL's family/customer ids come from the customer lookup) instead of being
 * hardcoded to the record used at authoring time. null when not chainable.
 */
function chainRef(
  value: string,
  lookups: Array<{ pathname: string }>,
  bodies: Map<string, string>,
): string | null {
  for (const lk of lookups) {
    const raw = bodies.get(lk.pathname);
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const path = findJsonPath(parsed, value);
    if (path) return `{{${outputKeyFor(lk.pathname)}.${path}}}`;
  }
  return null;
}

/**
 * Freeze a captured mutation into a deterministic `api` write step:
 *  - path ids that came from a lookup response → chained `{{customer.family.id}}`
 *  - a JSON body's string leaves → `{{key}}` inputs (lop:"english" → {{lop}})
 *  - goal-value tokens in the URL → their canonical inputs
 */
function buildMutationStep(
  req: CapturedRequest,
  tokens: string[],
  lookups: Array<{ pathname: string }>,
  bodies: Map<string, string>,
  localStorageSnapshot: Record<string, string> = {},
  nameForValue: (value: string, fallbackKey: string) => string = (_v, k) => inputNameFor(k),
): { step: Step; inputs: Record<string, string>; authReads: Step[] } | null {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return null;
  }
  const inputs: Record<string, string> = {};
  const authReads: Step[] = [];

  const newPath = u.pathname
    .split("/")
    .map((seg) => {
      if (!/^\d+$/.test(seg)) return seg;
      const chained = chainRef(seg, lookups, bodies);
      if (chained) return chained;
      if (tokens.includes(seg)) {
        inputs.id = `string — e.g. ${seg}`;
        return "{{id}}";
      }
      return seg; // couldn't resolve — left concrete for human review
    })
    .join("/");
  const urlOut = `${u.origin}${newPath}${u.search}`.replace(/%7B%7B/gi, "{{").replace(/%7D%7D/gi, "}}");

  let body: unknown;
  if (req.postData) {
    try {
      const walk = (val: unknown): unknown => {
        if (typeof val === "string") return val; // handled at the key level below
        if (Array.isArray(val)) return val.map(walk);
        if (val && typeof val === "object") {
          return Object.fromEntries(
            Object.entries(val as Record<string, unknown>).map(([k, x]) => {
              if (typeof x === "string" && x.length > 0) {
                const name = nameForValue(x, k);
                inputs[name] = `string — e.g. ${x}`;
                return [k, `{{${name}}}`];
              }
              return [k, walk(x)];
            }),
          );
        }
        return val;
      };
      body = walk(JSON.parse(req.postData));
    } catch {
      body = req.postData;
    }
  }

  // Auth/tenant headers: a mutation needs the same headers the SPA sends
  // (Authorization + x-* context like x-clinic-id / x-app-env). Static ones
  // (content-type) are emitted verbatim; value-bearing ones are read FRESH from
  // the page at run time — we discover WHERE by matching the captured header
  // value against localStorage (Bearer token → userToken, clinic id →
  // selectedClinicId, …), so no stale token is ever baked into the flow.
  const headers: Record<string, string> = {};
  const seenReads = new Set<string>();
  for (const [rawKey, rawVal] of Object.entries(req.headers ?? {})) {
    const k = rawKey.toLowerCase();
    if (!(k === "authorization" || k.startsWith("x-") || k === "content-type")) continue;
    if (k === "content-type") {
      headers[rawKey] = "application/json";
      continue;
    }
    // Split "Bearer <token>" so the token part can map to localStorage.
    const m = /^(Bearer\s+)(.+)$/i.exec(rawVal);
    const prefix = m ? m[1] : "";
    const valuePart = m ? m[2]! : rawVal;
    const lsKey = localStorageKeyForValue(valuePart, localStorageSnapshot);
    if (lsKey) {
      const inputName = inputNameFor(lsKey);
      if (!seenReads.has(inputName)) {
        seenReads.add(inputName);
        authReads.push({
          type: "read",
          label: `Read ${lsKey} from the page`,
          read: { expression: `localStorage.getItem(${JSON.stringify(lsKey)})`, as: inputName },
        } as unknown as Step);
      }
      headers[rawKey] = `${prefix}{{${inputName}}}`;
    } else {
      headers[rawKey] = rawVal; // not in localStorage — kept verbatim (review if session-specific)
    }
  }

  // Writes commonly return 204/empty — parse as text so an empty body isn't a
  // JSON error that masks a successful mutation.
  const api: ApiBlock = { url: urlOut, method: req.method, responseType: "text" };
  if (Object.keys(headers).length) api.headers = headers;
  if (body !== undefined) {
    api.body = body;
    api.bodyType = "json";
  }
  const step = {
    type: "read",
    label: `Update ${outputKeyFor(req.pathname)} (${req.method})`,
    api,
    extract: { key: `${outputKeyFor(req.pathname)}_update`, schema: {} as Record<string, unknown> },
  } as unknown as Step;
  return { step, inputs, authReads };
}

export function compileAgentRun(
  goal: string,
  finalUrl: string,
  responses: HarvestedResponse[],
  key: string,
  requests: CapturedRequest[] = [],
  responseBodies: Map<string, string> = new Map(),
  localStorageSnapshot: Record<string, string> = {},
  planParams: GoalParameter[] = [],
  intent: GoalPlan["intent"] = "update",
): Flow {
  // Preferred path: the goal names specific values (a phone/id) and the agent's
  // actions carried them. A GET LOOKUP (search by phone) is frozen as a
  // deep-link harvest — navigate the app page with the value as a query param
  // and INTERCEPT the response the page makes. The page performs the
  // AUTHENTICATED request itself, so there's no stale-token problem that a raw
  // API-replay would hit. A MUTATION (update) becomes a deterministic `api`
  // write step. Lookups run first so a write can reference what a read found.
  // Per-run VALUE tokens: digit-runs from the goal PLUS the values the query
  // rewriter named (a phone, a name, an update's target value like "english").
  // The rewriter is what lets non-numeric values become inputs — brute-force
  // digit-matching alone can't. A value→name map gives each a stable input name.
  const planByValue = new Map(planParams.filter((p) => p.value).map((p) => [p.value, p]));
  const tokens = [...new Set([...goalTokens(goal), ...planParams.map((p) => p.value).filter(Boolean)])];
  const nameForValue = (value: string, fallbackKey: string): string => {
    for (const [v, p] of planByValue) if (value.includes(v)) return p.name;
    return canonicalInputName(value, fallbackKey);
  };
  if (tokens.length > 0) {
    const lookups: Array<{ pathname: string; paramKey: string; name: string; example: string }> = [];
    const mutations: CapturedRequest[] = [];
    const inputs: Record<string, string> = {};
    const seenLookup = new Set<string>();
    const seenMut = new Set<string>();

    // First pass: classify lookups (GET carrying a goal value) and mutations.
    for (const r of dedupeRequests(requests)) {
      if (INTEGRATION_NOISE_RE.test(r.pathname)) continue; // peripheral integration
      const method = r.method.toUpperCase();
      if (method === "GET" || method === "HEAD") {
        let u: URL;
        try {
          u = new URL(r.url);
        } catch {
          continue;
        }
        let hit: { paramKey: string; name: string; example: string } | undefined;
        for (const [k, v] of u.searchParams.entries()) {
          const tok = tokens.find((t) => v.includes(t));
          if (tok) {
            hit = { paramKey: k, name: nameForValue(v, k), example: v };
            break;
          }
        }
        if (!hit) continue;
        const sig = `${r.pathname} ${hit.paramKey}`;
        if (seenLookup.has(sig)) continue;
        seenLookup.add(sig);
        lookups.push({ pathname: r.pathname, ...hit });
        inputs[hit.name] = `string — e.g. ${hit.example}`;
      } else {
        // Only an UPDATE goal yields writes — a read/search must never emit a
        // mutation (the rewriter's intent guards against session/heartbeat
        // POSTs a page fires on its own being mistaken for a user write).
        if (intent !== "update") continue;
        if (MUTATION_NOISE_RE.test(r.pathname)) continue; // infra POST, not a user mutation
        const sig = `${method} ${r.pathname}`;
        if (seenMut.has(sig)) continue;
        seenMut.add(sig);
        mutations.push(r);
      }
    }

    // Second pass: build mutation steps now that lookups (and their response
    // bodies) are known, so the write's ids chain off the search result.
    const mutationSteps: Step[] = [];
    const authReadSteps: Step[] = [];
    const seenAuthRead = new Set<string>();
    for (const r of mutations) {
      const built = buildMutationStep(r, tokens, lookups, responseBodies, localStorageSnapshot, nameForValue);
      if (!built) continue;
      for (const rd of built.authReads) {
        const as = (rd as unknown as { read?: { as?: string } }).read?.as ?? "";
        if (seenAuthRead.has(as)) continue;
        seenAuthRead.add(as);
        authReadSteps.push(rd);
      }
      mutationSteps.push(built.step);
      Object.assign(inputs, built.inputs);
    }

    if (lookups.length > 0 || mutationSteps.length > 0) {
      const steps: Step[] = [];
      for (const lk of lookups) {
        steps.push({
          type: "intercept",
          label: `Capture ${outputKeyFor(lk.pathname)} lookup`,
          intercept: { url_contains: idFreeMatch(lk.pathname), as: outputKeyFor(lk.pathname) },
        });
      }
      if (lookups.length > 0) {
        // Deep-link the app page with each lookup's query param → the page runs
        // the authenticated search itself; we intercept the result.
        const nav = new URL(finalUrl);
        for (const lk of lookups) nav.searchParams.set(lk.paramKey, `{{${lk.name}}}`);
        const navUrl = nav.toString().replace(/%7B%7B/gi, "{{").replace(/%7D%7D/gi, "}}");
        steps.push({ type: "navigate", label: "Open the page (deep-linked search)", url: navUrl });
        steps.push({
          type: "wait",
          label: `Wait for ${outputKeyFor(lookups[0]!.pathname)}`,
          wait: { for: outputKeyFor(lookups[0]!.pathname), timeout_ms: 20000 },
        });
      }
      steps.push(...authReadSteps, ...mutationSteps);
      return {
        key,
        version: 1,
        description: `Agent-authored from the goal: ${goal}`,
        inputs: Object.keys(inputs).length ? inputs : undefined,
        // A read-only flow keeps the full guard; a captured mutation relaxes
        // forbidden_actions but stays dry_run_only until a human confirms it.
        guard: mutationSteps.length
          ? { no_booking: true, dry_run_only: true }
          : { no_booking: true, forbidden_actions: ["ReserveAppointment", "book", "confirm"], dry_run_only: true },
        steps,
      };
    }
  }

  const { url, inputs } = parameterizeUrl(finalUrl, planParams);
  // The id values the agent's navigation resolved to (e.g. 4299 from
  // ?claimId=4299). Endpoints carrying these ids are THIS claim's data — the
  // strongest signal for "what the goal was actually about", and it ties the
  // harvested data to the navigation target rather than guessing by size.
  const idValues = idsInUrl(finalUrl);

  const family = (p: string) => p.replace(/\/\d+(?=\/|$)/g, "/*");
  const byFamily = new Map<string, HarvestedResponse>();
  for (const r of responses) {
    const f = family(r.pathname);
    const prev = byFamily.get(f);
    if (!prev || r.bytes > prev.bytes) byFamily.set(f, r);
  }

  const score = (r: HarvestedResponse): number => {
    if (BOOT_NOISE_RE.test(r.pathname)) return -1; // never harvest infra/boot noise
    let s = Math.log10(Math.max(1, r.bytes)); // size is a weak tiebreak, not primary
    if (idValues.some((id) => r.url.includes(id))) s += 100; // carries the navigated claim's id
    return s;
  };
  const ranked = [...byFamily.values()]
    .filter((r) => score(r) >= 0)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3);

  const steps: Step[] = [];
  const harvestKeys: string[] = [];
  ranked.forEach((r, i) => {
    // Intercept on an id-free substring that ACTUALLY appears in the live URL so
    // replay matches any run's id: the trailing path after a numeric segment
    // (/claims/4305/ai-review-history → /ai-review-history), else the prefix
    // before a trailing id, else the whole path (a plain list endpoint).
    const match = idFreeMatch(r.pathname);
    const as = i === 0 ? "data_raw" : `data_${i}`;
    harvestKeys.push(as);
    steps.push({
      type: "intercept",
      label: `Capture ${match.split("/").filter(Boolean).pop() ?? "data"} response`,
      intercept: { url_contains: match, as },
    });
  });

  steps.push({ type: "navigate", label: "Open the target page", url });

  // Wait on the primary harvest so the flow only succeeds once real data landed.
  if (harvestKeys[0]) {
    steps.push({
      type: "wait",
      label: "Wait for data",
      wait: { for: harvestKeys[0], timeout_ms: 20000 },
    });
  }

  return {
    key,
    version: 1,
    description: `Agent-authored from the goal: ${goal}`,
    inputs: Object.keys(inputs).length ? inputs : undefined,
    guard: { no_booking: true, forbidden_actions: ["ReserveAppointment", "book", "confirm"], dry_run_only: true },
    steps,
  };
}

/**
 * In-page capture-phase click hook (string so this package needs no DOM lib).
 * For each meaningful click it calls the exposed `__porticoOnClick` binding,
 * which pushes the interaction to Node IMMEDIATELY — so it survives the full-page
 * navigations legacy portals (Epic MyChart) use, with no in-page buffer to lose.
 * Mirrors the record-attach recorder's shape so `compileRecording` can consume it.
 */
const CLICK_CAPTURE_SCRIPT = `(() => {
  if (window.__porticoHook) return; window.__porticoHook = true;
  // Absolute XPath in Stagehand's form (xpath=/html[1]/body[1]/…) so a captured
  // click can be correlated with the agent's own resolved selector at authoring.
  function xp(el){
    var parts=[];
    for(; el && el.nodeType===1; el=el.parentElement){
      var ix=1, sib=el.previousElementSibling;
      while(sib){ if(sib.tagName===el.tagName) ix++; sib=sib.previousElementSibling; }
      parts.unshift(el.tagName.toLowerCase()+"["+ix+"]");
    }
    return parts.length ? "xpath=/"+parts.join("/") : "";
  }
  document.addEventListener("click", (e) => {
    try {
      var t = e.target;
      var el = (t && t.closest && t.closest("button,a[href],[role=button],[role=option],[role=menuitem],[role=menuitemradio],[role=tab],[role=radio],[role=checkbox],[role=switch],[role=link],summary,label")) || t;
      if (!el || !el.getAttribute) return;
      var text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 90);
      if (window.__porticoOnClick) window.__porticoOnClick({
        tag: el.tagName, role: el.getAttribute("role"), ariaLabel: el.getAttribute("aria-label"),
        text: text, id: el.id || null, name: el.getAttribute("name"),
        testid: el.getAttribute("data-testid") || el.getAttribute("data-test-id") || null,
        href: el.getAttribute("href"), url: location.href, xpath: xp(el)
      });
    } catch (err) {}
  }, true);
})();`;

/**
 * A real, replayable control's accessible name is CONCISE. When a click resolves
 * to a big container (or a dashboard notification card), its captured label is a
 * long blob of concatenated inner text — not something a semantic locator can
 * match on a fresh run. Empirically real controls sit well under this; container
 * mis-captures run 75+ chars. Above it, drop the click as noise.
 */
const MAX_CONTROL_LABEL = 72;

/**
 * Keep only the captured clicks that are real, replayable SOP interactions:
 * a concise accessible name, and not a sign-in step. Drops container/notification
 * blobs (over-long labels) and login clicks — the noise that would make a frozen
 * `act` step fail on replay. Order-preserving.
 *
 * NOTE: "Continue" is deliberately NOT treated as a login token — it is a common
 * page-advancing control inside authenticated scheduling wizards ("Continue to
 * Scheduling"), and dropping it would break the replay by skipping a real step.
 * Actual login pages can't reach compilation anyway (the auth-wall gate blocks
 * logged-out runs), so the genuine auth tokens below are enough.
 */
export function replayableClicks(clicks: ClickEvent[]): ClickEvent[] {
  return clicks.filter((c) => {
    const label = (c.ariaLabel ?? c.text ?? c.name ?? c.testid ?? "").toString().trim();
    if (!label || label.length > MAX_CONTROL_LABEL) return false;
    return !/\b(log ?in|sign ?in|password|username|passkey)\b/i.test(label);
  });
}

/**
 * A time of day or numeric date is ALWAYS ephemeral — "8:00 AM", "3/15",
 * "Oct 12". These forms never appear in a control's stable name.
 */
const TIME_OR_NUMDATE_RE =
  /\b\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)?\b|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}\b/i;

/** A full weekday or month WORD (excludes "may" — too common in English). */
const WEEKDAY_MONTH_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b/i;

/**
 * Weekday / month / date / time control labels are EPHEMERAL: the specific slot
 * the agent picked ("Monday", "October 12", "8:00 AM") will NOT exist on replay,
 * so freezing it as a literal `act` step breaks every future run. Portal-agnostic
 * — dates and times look the same on every scheduler.
 *
 * A bare weekday/month word alone is NOT enough to call something ephemeral, or
 * we'd wrongly truncate at real controls whose NAME contains one — provider and
 * insurer names like "Dr. April Johnson", "June Health Clinic", "Friday Health
 * Plans". So a weekday/month word only counts when the label is essentially just
 * that date (the word plus day-numbers / ordinals / year / punctuation and
 * nothing else) — a date-picker cell, not a proper name that happens to contain
 * a month.
 */
export function isEphemeralSlotLabel(label: string): boolean {
  const s = (label ?? "").trim();
  if (!s) return false;
  if (TIME_OR_NUMDATE_RE.test(s)) return true;
  if (!WEEKDAY_MONTH_RE.test(s)) return false;
  // Strip every date-ish token; if nothing meaningful remains, it's a date cell.
  const residue = s
    .replace(new RegExp(WEEKDAY_MONTH_RE.source, "gi"), " ")
    .replace(/\b\d{1,4}(st|nd|rd|th)?\b/gi, " ") // day numbers, ordinals, year
    .replace(/\b(the|of|at|on)\b/gi, " ")
    .replace(/[.,\-–—:/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return residue.length === 0;
}

/**
 * Truncate the click sequence at the first ephemeral date/time selection — the
 * point where the wizard turns dynamic. Everything before it is a deterministic
 * path TO the slot screen (which the flow then harvests); the slot itself, and
 * anything after it, depends on a given run's availability and must never be
 * frozen as literal clicks. Returns the kept prefix and whether it truncated.
 */
export function stopAtEphemeralSlot(clicks: ClickEvent[]): { clicks: ClickEvent[]; truncated: boolean } {
  const out: ClickEvent[] = [];
  for (const c of clicks) {
    const label = (c.ariaLabel ?? c.text ?? c.name ?? c.testid ?? "").toString();
    if (isEphemeralSlotLabel(label)) return { clicks: out, truncated: true };
    out.push(c);
  }
  return { clicks: out, truncated: false };
}

/**
 * Drive `goal` on the live (already-authenticated) browser with Stagehand,
 * capture the network + final URL, and compile a deterministic flow.
 *
 * Compliance note: this sends live DOM to the configured model. For real PHI,
 * the model MUST be a BAA-covered route and DOM values redacted first (see
 * docs/REBUILD-PROPOSAL.md §3.3). Fine for staging/synthetic authoring.
 */
export async function authorFlow(opts: AuthorOptions): Promise<AuthorResult> {
  const responses: HarvestedResponse[] = [];
  const requests: CapturedRequest[] = [];
  // Latest response body per pathname (non-boot JSON, capped) — lets the compiler
  // resolve where a mutation's ids came from in a lookup response, for chaining.
  const responseBodies = new Map<string, string>();
  // Durable action + network capture for compiling an action-replay SOP flow:
  // every meaningful click the agent makes (pushed live via a page binding) and
  // every JSON data response, in the shape `compileRecording` consumes.
  const clicks: ClickEvent[] = [];
  const network: NetworkEntry[] = [];

  // Independent Playwright CDP client on the SAME browser — observes every JSON
  // response the agent's actions trigger, without depending on Stagehand's page
  // event surface.
  const observer = await chromium.connectOverCDP(opts.cdpUrl);
  const observerCtx: BrowserContext = observer.contexts()[0] ?? (await observer.newContext());
  // Capture search + mutation REQUESTS (with bodies) so a typed search or an
  // update can be frozen into a deterministic `api` step — not just GET reads.
  observerCtx.on("request", (req) => {
    const method = req.method().toUpperCase();
    const rt = req.resourceType();
    if (rt !== "xhr" && rt !== "fetch") return;
    // Capture everything API-ish: mutations (POST/PUT/PATCH/DELETE) become
    // `api` write steps; a GET/POST "search" carries the query we parameterize.
    // Boot noise is dropped at compile time (dedupeRequests / BOOT_NOISE_RE).
    const url = req.url();
    let postData: string | undefined;
    try {
      postData = req.postData() ?? undefined;
    } catch {
      postData = undefined;
    }
    let headers: Record<string, string> | undefined;
    try {
      headers = req.headers();
    } catch {
      headers = undefined;
    }
    requests.push({ method, url, pathname: pathnameOf(url), resourceType: rt, postData, headers });
  });
  observerCtx.on("response", (resp) => {
    const req = resp.request();
    const ct = resp.headers()["content-type"] ?? "";
    if (!isDataResponse(resp.status(), ct, req.resourceType())) return;
    const url = resp.url();
    // content-length is frequently absent (chunked/compressed), so read the
    // actual decoded body length — size is only a tiebreak, but a real one.
    resp
      .body()
      .then((buf) => {
        const pathname = pathnameOf(url);
        responses.push({ url, pathname, bytes: buf.length, contentType: ct });
        const small = buf.length <= 262144;
        // Keep small non-boot JSON bodies for id-chaining (latest wins).
        if (small && !BOOT_NOISE_RE.test(pathname)) responseBodies.set(pathname, buf.toString("utf8"));
        // Record for the action-replay compiler (it picks the intercept target
        // from these JSON data responses; a body preview helps it detect slots).
        network.push({
          method: req.method(),
          url,
          resourceType: req.resourceType(),
          status: resp.status(),
          contentType: ct,
          responseBodyPreview: small ? buf.toString("utf8").slice(0, 4000) : null,
          responseBodyBytes: buf.length,
        });
      })
      .catch(() => responses.push({ url, pathname: pathnameOf(url), bytes: Number(resp.headers()["content-length"] ?? 0), contentType: ct }));
  });

  // Live click capture: a page binding pushes each interaction to Node the moment
  // it happens, and an init script installs the capture-phase listener on every
  // page the agent loads. Best-effort — if the CDP context rejects either, we
  // simply fall back to the navigate+harvest compiler.
  try {
    await observerCtx.exposeBinding("__porticoOnClick", (_src, click: ClickEvent) => {
      if (click && typeof click === "object") clicks.push(click);
    });
    await observerCtx.addInitScript(CLICK_CAPTURE_SCRIPT);
  } catch {
    /* binding already present or unsupported — action-replay just won't trigger */
  }

  const wsUrl = await resolveCdpWsUrl(opts.cdpUrl);
  const sh = new Stagehand({
    env: "LOCAL",
    model: { modelName: opts.model as never, apiKey: opts.apiKey },
    localBrowserLaunchOptions: { cdpUrl: wsUrl },
    // Stagehand's default pino logger writes to STDOUT, which would corrupt a
    // caller that emits the compiled flow on stdout. Silence pino and forward
    // log lines through onLog (callers send those to stderr).
    verbose: 1,
    disablePino: true,
    logger: (line) => opts.onLog?.(`[stagehand] ${line.category ?? ""}: ${line.message ?? ""}`),
  });

  // Plan the goal FIRST: a decomposed, explicit instruction is what makes the
  // browser agent complete reliably, and the named parameters drive precise
  // compilation. Degrades to the raw goal when no model / on failure.
  log(opts, "planning the goal…");
  const plan = await rewriteGoal(opts.goal, {
    model: opts.model,
    apiKey: opts.apiKey,
    startUrl: opts.startUrl,
    onLog: opts.onLog,
  });
  log(opts, `plan: intent=${plan.intent}, params=[${plan.parameters.map((p) => p.name).join(", ")}]`);

  try {
    log(opts, "attaching agent to the live session…");
    await sh.init();
    const page = sh.context.activePage() ?? sh.context.pages()[0] ?? (await sh.context.newPage());
    // Preserve an already-authenticated tab: force-navigating a logged-in
    // session to the start URL (a bare root especially) can drop the session —
    // Epic MyChart clears its auth cookies on a root hit. Only navigate from a
    // blank tab or a different origin; otherwise start where the human logged in
    // and let the agent move within the app.
    if (shouldNavigateToStart(page.url(), opts.startUrl)) {
      log(opts, `navigating to start URL: ${opts.startUrl}`);
      await page.goto(opts.startUrl);
    } else {
      log(opts, `already on the portal (${page.url()}) — preserving the authenticated page instead of navigating to the start URL`);
    }
    // The authenticated entry point the agent starts from — the action-replay
    // flow re-enters here (NOT the bare root, which would drop the session), then
    // replays the click sequence. addInitScript only covers pages loaded AFTER
    // it was set, so install the click listener into THIS already-loaded page too.
    const replayBaseUrl = sh.context.activePage()?.url() ?? page.url();
    try {
      await (sh.context.activePage() ?? page).evaluate(CLICK_CAPTURE_SCRIPT);
    } catch {
      /* best-effort — future pages still get it via addInitScript */
    }

    log(opts, `agent working toward the refined goal`);
    const agent = sh.agent();
    // A multi-step wizard SOP (click category → sub-type → location → time
    // slot → review, …) needs real headroom: the agent burns several turns per
    // logical step (observe → click → wait), so a flat 12-step cap was cutting
    // it off after the first click or two (the goal-adherence bug this guards
    // against). Floors: an update already got 24; reads/navigations now get a
    // substantially higher floor too. On top of the floor, scale with the
    // refined goal's own numbered-step count (~6 agent turns per logical step)
    // so a longer SOP gets proportionally more room — and always keep at least
    // the caller's explicit budget.
    const STEPS_PER_INSTRUCTION = 6;
    const floor = plan.intent === "update" ? 24 : 30;
    const scaled = countPlanSteps(plan.refinedGoal) * STEPS_PER_INSTRUCTION;
    const budget = Math.max(opts.maxSteps ?? 12, floor, scaled);
    const result = await agent.execute({ instruction: plan.refinedGoal, maxSteps: budget });

    const finalUrl = sh.context.activePage()?.url() ?? page.url();
    log(opts, `agent ${result.success ? "reached" : "stopped at"}: ${finalUrl}`);
    // Let in-flight response-body reads (async) settle before we compile.
    await new Promise((r) => setTimeout(r, 1500));

    // Precondition gate: refuse to compile a run captured while NOT logged in.
    // A logged-out session yields a login page / guest funnel, which would
    // freeze into a dead flow that only fails later at validation. Detect it
    // here and fail loudly with an actionable message. The DOM signal (visible
    // password field + title) comes from the live page; the classification is
    // the pure, unit-tested detectAuthWall.
    let authTitle = "";
    let hasPasswordField = false;
    try {
      const pg = sh.context.activePage() ?? page;
      const sig = await pg.evaluate(() => {
        // Reference the DOM through globalThis so this package needs no "dom"
        // lib (it stays isolated from a browser type surface); the callback
        // runs in the page, where document exists.
        const doc = (globalThis as unknown as {
          document?: {
            title?: string;
            querySelectorAll: (s: string) => ArrayLike<{ getClientRects: () => { length: number } }>;
          };
        }).document;
        if (!doc) return { title: "", hasPasswordField: false };
        const nodes = Array.from(doc.querySelectorAll('input[type="password"]'));
        const visible = nodes.some((el) => el.getClientRects().length > 0);
        return { title: doc.title || "", hasPasswordField: visible };
      });
      authTitle = sig.title;
      hasPasswordField = sig.hasPasswordField;
    } catch {
      /* best-effort DOM read — fall back to URL/request signals only */
    }
    const authWall = detectAuthWall({ finalUrl, title: authTitle, hasPasswordField, requests });
    if (authWall.blocked) {
      log(opts, `authentication gate: ${authWall.reason}`);
      throw new Error(authWall.reason);
    }

    // Snapshot localStorage so a captured mutation's auth/tenant headers can be
    // mapped to the page keys they live in (userToken, selectedClinicId, …) and
    // read fresh at run time instead of baking a stale token into the flow.
    let localStorageSnapshot: Record<string, string> = {};
    try {
      const p = sh.context.activePage() ?? page;
      localStorageSnapshot = await p.evaluate(() => {
        const out: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k) out[k] = localStorage.getItem(k) ?? "";
        }
        return out;
      });
    } catch {
      /* best-effort — writes without discoverable auth keep headers verbatim */
    }

    // Compiler choice:
    //  • An UPDATE keeps the deterministic api-write path (compileAgentRun) — it
    //    chains ids from the lookup and reads auth headers fresh; replaying a
    //    "Save" click is riskier than a frozen PUT.
    //  • A read/navigation SOP where the agent drove a MULTI-STEP wizard compiles
    //    to an ACTION-REPLAY flow (compileRecording) that reproduces the click
    //    sequence, so the frozen flow actually FOLLOWS the SOP instead of just
    //    navigating to a URL and harvesting (the URMC scheduling gap).
    //  • Otherwise (a single deep-link that loads the data) → navigate+harvest.
    const key = opts.key ?? "authored-flow";
    // Two-source reconciliation: correlate the agent's OWN action stream (intent +
    // resolved element) with the raw DOM clicks, so the replay follows what the
    // agent DELIBERATELY did (dropping dashboard/notification noise the agent never
    // touched) with resilient role+name locators. Falls back to the raw hook clicks
    // when the agent stream is thin or doesn't correlate — no regression. Kill via
    // PORTICO_AUTHOR_NO_RECONCILE=1.
    const agentActions = extractAgentActions(result.actions);
    const reconcile = process.env.PORTICO_AUTHOR_NO_RECONCILE
      ? { steps: clicks, meta: [] as ReconcileMeta[], usedAgentStream: false, droppedNoise: 0 }
      : reconcileClicks(clicks, agentActions);
    if (reconcile.usedAgentStream) {
      const agentOnly = reconcile.meta.filter((m) => m.source === "agent-only").length;
      log(
        opts,
        `reconciled ${clicks.length} DOM click(s) against ${agentActions.length} agent action(s) → ${reconcile.steps.length} intentional step(s) ` +
          `(${agentOnly} agent-only, ~${reconcile.droppedNoise} noise dropped)`,
      );
    } else if (agentActions.length > 0) {
      log(opts, `agent action stream present (${agentActions.length}) but not correlated — using DOM-hook clicks`);
    }
    const replaySource = reconcile.usedAgentStream ? reconcile.steps : clicks;
    // Filter noise, then STOP at the first dynamic date/time selection: the slot
    // the agent clicked ("Monday …") won't exist next run, so the flow replays
    // the deterministic path to the slot screen and harvests the slots there.
    const { clicks: replay, truncated } = stopAtEphemeralSlot(replayableClicks(replaySource));
    if (truncated) {
      log(opts, "reached the dynamic time-slot screen — stopping the deterministic replay there and harvesting the available slots (a specific past date is never frozen as a click)");
    }
    let flow: Flow;
    if (plan.intent !== "update" && replay.length >= 2) {
      log(opts, `compiling ACTION-REPLAY SOP flow from ${replay.length} interactions (source: ${reconcile.usedAgentStream ? "agent+DOM reconciled" : "DOM clicks"}, ${clicks.length} raw captured)`);
      // emitSelect:false — the recorder's slot-pick step hardcodes one portal's
      // response shape; an authored flow harvests the data and stops at the SOP.
      flow = compileRecording({ baseUrl: replayBaseUrl, clicks: replay, network }, { key, emitSelect: false });
      flow.description = `Agent-authored (action replay) from the goal: ${opts.goal}`;
    } else {
      log(opts, `compiling navigate+harvest flow (${replay.length} interactions, intent=${plan.intent})`);
      flow = compileAgentRun(
        opts.goal,
        finalUrl,
        responses,
        key,
        requests,
        responseBodies,
        localStorageSnapshot,
        plan.parameters,
        plan.intent,
      );
    }
    return {
      flow,
      evidence: {
        goal: opts.goal,
        finalUrl,
        agentSuccess: result.success,
        agentMessage: result.message,
        actions: result.actions ?? [],
        agentActions,
        /** Every raw DOM click the hook captured (before reconcile) — the ground
         *  truth for diagnosing capture gaps (missed clicks / container blobs). */
        rawClicks: clicks,
        reconciliation: {
          usedAgentStream: reconcile.usedAgentStream,
          steps: reconcile.steps.length,
          droppedNoise: reconcile.droppedNoise,
          meta: reconcile.meta,
          /** The reconciled steps that were compiled (post-filter). */
          compiledSteps: replay.map((c) => ({ text: c.ariaLabel ?? c.text, role: c.role, id: c.id, testid: c.testid, xpath: c.xpath })),
        },
        dataEndpoints: [...new Set(responses.map((r) => r.pathname))],
        writeRequests: dedupeRequests(requests),
        plan,
      },
    };
  } finally {
    await sh.close().catch(() => {});
    await observer.close().catch(() => {});
  }
}
