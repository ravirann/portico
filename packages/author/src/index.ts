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
  /\/(permissions|flags|userinfo|session|clinics|tickets|me|config|health|analytics|telemetry|events|log)\b/i;

export function compileAgentRun(
  goal: string,
  finalUrl: string,
  responses: HarvestedResponse[],
  key: string,
): Flow {
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

  // Independent Playwright CDP client on the SAME browser — observes every JSON
  // response the agent's actions trigger, without depending on Stagehand's page
  // event surface.
  const observer = await chromium.connectOverCDP(opts.cdpUrl);
  const observerCtx: BrowserContext = observer.contexts()[0] ?? (await observer.newContext());
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

    const flow = compileAgentRun(opts.goal, finalUrl, responses, opts.key ?? "authored-flow");
    return {
      flow,
      evidence: {
        goal: opts.goal,
        finalUrl,
        agentSuccess: result.success,
        agentMessage: result.message,
        actions: result.actions ?? [],
        dataEndpoints: [...new Set(responses.map((r) => r.pathname))],
      },
    };
  } finally {
    await sh.close().catch(() => {});
    await observer.close().catch(() => {});
  }
}
