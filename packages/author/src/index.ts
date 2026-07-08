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
import type { Flow, Step } from "@portico/flow-spec";
import { rewriteGoal, type GoalPlan, type GoalParameter } from "./rewrite.js";

export { rewriteGoal, normalizePlan } from "./rewrite.js";
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
  /** Max agent steps before giving up. Default 12. */
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
    actions: unknown[];
    dataEndpoints: string[];
    /** Search/mutation requests captured with bodies (for write-flow authoring). */
    writeRequests: CapturedRequest[];
    /** The rewriter's structured plan of the goal. */
    plan: GoalPlan;
  };
}

const log = (opts: AuthorOptions, s: string) => opts.onLog?.(s);

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
function parameterizeUrl(finalUrl: string): { url: string; inputs: Record<string, string> } {
  const inputs: Record<string, string> = {};
  let u: URL;
  try {
    u = new URL(finalUrl);
  } catch {
    return { url: finalUrl, inputs };
  }
  for (const [k, v] of [...u.searchParams.entries()]) {
    // A stable id-shaped param (all digits) is the per-run value; template it.
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

  const { url, inputs } = parameterizeUrl(finalUrl);
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
        // Keep small non-boot JSON bodies for id-chaining (latest wins).
        if (buf.length <= 262144 && !BOOT_NOISE_RE.test(pathname)) responseBodies.set(pathname, buf.toString("utf8"));
      })
      .catch(() => responses.push({ url, pathname: pathnameOf(url), bytes: Number(resp.headers()["content-length"] ?? 0), contentType: ct }));
  });

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
    await page.goto(opts.startUrl);

    log(opts, `agent working toward the refined goal`);
    const agent = sh.agent();
    // A write needs more room than a read; give the agent headroom, and always
    // at least the caller's budget.
    const budget = Math.max(opts.maxSteps ?? 12, plan.intent === "update" ? 24 : 12);
    const result = await agent.execute({ instruction: plan.refinedGoal, maxSteps: budget });

    const finalUrl = sh.context.activePage()?.url() ?? page.url();
    log(opts, `agent ${result.success ? "reached" : "stopped at"}: ${finalUrl}`);
    // Let in-flight response-body reads (async) settle before we compile.
    await new Promise((r) => setTimeout(r, 1500));

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

    const flow = compileAgentRun(
      opts.goal,
      finalUrl,
      responses,
      opts.key ?? "authored-flow",
      requests,
      responseBodies,
      localStorageSnapshot,
      plan.parameters,
    );
    return {
      flow,
      evidence: {
        goal: opts.goal,
        finalUrl,
        agentSuccess: result.success,
        agentMessage: result.message,
        actions: result.actions ?? [],
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
