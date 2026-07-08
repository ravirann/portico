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
const BOOT_NOISE_RE =
  /\/(permissions|flags|userinfo|session|clinics|tickets|me|config|health|analytics|telemetry|events|log|collect|faro|rum|metrics|beacon)\b/i;

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
  body?: unknown;
  bodyType?: "json";
  responseType?: "json";
}

/**
 * Turn a captured request into a deterministic `api` step IF it carries a
 * goal value (a phone/id the flow must parameterize) — replacing that value in
 * the URL query and JSON body with a `{{input}}` marker. Returns null for
 * requests that carry no goal value (plain reads — covered by harvest).
 */
function apiStepFromRequest(
  req: CapturedRequest,
  tokens: string[],
): { step: Step; inputs: Record<string, string>; isMutation: boolean } | null {
  const inputs: Record<string, string> = {};
  let matched = false;

  let url: string;
  try {
    url = new URL(req.url).toString();
  } catch {
    return null;
  }
  const u = new URL(url);
  for (const [k, v] of [...u.searchParams.entries()]) {
    const tok = tokens.find((t) => v.includes(t));
    if (!tok) continue;
    const name = canonicalInputName(tok, k);
    inputs[name] = `string — e.g. ${v}`;
    u.searchParams.set(k, v.replace(tok, `{{${name}}}`));
    matched = true;
  }
  const urlOut = u.toString().replace(/%7B%7B/gi, "{{").replace(/%7D%7D/gi, "}}");

  // Parameterize goal values inside a JSON body too.
  let body: unknown;
  if (req.postData) {
    try {
      const parsed = JSON.parse(req.postData) as unknown;
      const walk = (val: unknown): unknown => {
        if (typeof val === "string") {
          const tok = tokens.find((t) => val.includes(t));
          if (tok) {
            matched = true;
            // Body values are usually the id/phone itself; name after the token's role.
            const name = "phone_number";
            inputs[name] = `string — e.g. ${val}`;
            return val.replace(tok, `{{${name}}}`);
          }
          return val;
        }
        if (Array.isArray(val)) return val.map(walk);
        if (val && typeof val === "object") {
          return Object.fromEntries(Object.entries(val as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
        }
        return val;
      };
      body = walk(parsed);
    } catch {
      body = req.postData;
    }
  }

  const isMutation = !["GET", "HEAD"].includes(req.method);
  if (!matched && !isMutation) return null; // a plain read with no goal value — leave to harvest

  const api: ApiBlock = { url: urlOut, method: req.method, responseType: "json" };
  if (body !== undefined) {
    api.body = body;
    api.bodyType = "json";
  }
  const step = {
    type: "read",
    label: `${isMutation ? "Update via" : "Look up via"} ${outputKeyFor(req.pathname)} API`,
    api,
    extract: { key: outputKeyFor(req.pathname), schema: {} as Record<string, unknown> },
  } as unknown as Step;
  return { step, inputs, isMutation };
}

export function compileAgentRun(
  goal: string,
  finalUrl: string,
  responses: HarvestedResponse[],
  key: string,
  requests: CapturedRequest[] = [],
): Flow {
  // Preferred path: the goal names specific values (a phone/id) and the agent's
  // actions carried them. A GET LOOKUP (search by phone) is frozen as a
  // deep-link harvest — navigate the app page with the value as a query param
  // and INTERCEPT the response the page makes. The page performs the
  // AUTHENTICATED request itself, so there's no stale-token problem that a raw
  // API-replay would hit. A MUTATION (update) becomes a deterministic `api`
  // write step. Lookups run first so a write can reference what a read found.
  const tokens = goalTokens(goal);
  if (tokens.length > 0) {
    const lookups: Array<{ pathname: string; paramKey: string; name: string; example: string }> = [];
    const mutationSteps: Step[] = [];
    const inputs: Record<string, string> = {};
    const seenLookup = new Set<string>();
    const seenMut = new Set<string>();

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
            hit = { paramKey: k, name: canonicalInputName(tok, k), example: v };
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
        const built = apiStepFromRequest(r, tokens);
        if (!built) continue;
        const sig = `${method} ${r.pathname}`;
        if (seenMut.has(sig)) continue;
        seenMut.add(sig);
        mutationSteps.push(built.step);
        Object.assign(inputs, built.inputs);
      }
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
      steps.push(...mutationSteps);
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
    requests.push({ method, url, pathname: pathnameOf(url), resourceType: rt, postData });
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
      .then((buf) => responses.push({ url, pathname: pathnameOf(url), bytes: buf.length, contentType: ct }))
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

  try {
    log(opts, "attaching agent to the live session…");
    await sh.init();
    const page = sh.context.activePage() ?? sh.context.pages()[0] ?? (await sh.context.newPage());
    await page.goto(opts.startUrl);

    log(opts, `agent working toward: ${opts.goal}`);
    const agent = sh.agent();
    const result = await agent.execute({ instruction: opts.goal, maxSteps: opts.maxSteps ?? 12 });

    const finalUrl = sh.context.activePage()?.url() ?? page.url();
    log(opts, `agent ${result.success ? "reached" : "stopped at"}: ${finalUrl}`);
    // Let in-flight response-body reads (async) settle before we compile.
    await new Promise((r) => setTimeout(r, 1500));

    const flow = compileAgentRun(opts.goal, finalUrl, responses, opts.key ?? "authored-flow", requests);
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
      },
    };
  } finally {
    await sh.close().catch(() => {});
    await observer.close().catch(() => {});
  }
}
