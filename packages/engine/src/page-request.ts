/**
 * In-house in-page HTTP request (ADR-0004 — replaces the removed third-party
 * dependency's `pageRequest`).
 *
 * `apiStep` (compiler.ts) drives an API-tier step through the PAGE's own
 * fetch — same-origin cookies/session apply automatically, and the request
 * shows up in the page's own network stack (so egress enforcement in
 * runner.ts, which routes `context.route("**\/*", …)`, sees and can block it
 * exactly like any other in-page request). `apiStep` only ever consumes the
 * final parsed body (schema-validated when a schema is given) or a thrown
 * Error on a non-2xx status — never the raw `{status, ok, data}` envelope —
 * so that is the return contract reproduced here.
 *
 * Runs the fetch via `page.evaluate` on a SELF-CONTAINED source string (the
 * request config is JSON-embedded into the string, not passed as an
 * `evaluate` `arg`) — Playwright only forwards `arg` when `pageFunction` is a
 * real function value; a string `pageFunction` is evaluated as a bare
 * expression and any `arg` is silently dropped. This is also why the engine
 * package deliberately compiles without the DOM lib (see `waitForDomQuiet`
 * in compiler.ts): a typed arrow function referencing `fetch`/`Headers` in
 * page context wouldn't type-check here anyway, and the string form sidesteps
 * that too.
 */

import type { Page } from "playwright";
import type { z } from "zod";

export interface RequestConfig {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: Record<string, unknown> | string;
  /** How to serialize the body. Defaults to "json". */
  bodyType?: "json" | "form";
  /** How to parse the response. Defaults to "json". */
  responseType?: "json" | "text" | "xml";
}

export interface PageRequestOptions<T extends z.ZodType | undefined = undefined> {
  /** Optional Zod schema to validate the response body. */
  schema?: T;
}

type PageRequestResult<T extends z.ZodType | undefined> = T extends z.ZodType ? z.infer<T> : unknown;

interface RawEvaluateResult {
  status: number;
  ok: boolean;
  data: unknown;
}

/**
 * Execute a `fetch()` call inside the browser context via `page.evaluate()`.
 * Same-origin, so the page's own cookies/session headers apply. Throws on a
 * non-2xx status; returns the schema-parsed body (or the raw parsed body with
 * no schema) on success.
 */
export async function pageRequest<T extends z.ZodType | undefined = undefined>(
  page: Page,
  config: RequestConfig,
  options?: PageRequestOptions<T>,
): Promise<PageRequestResult<T>> {
  const {
    url,
    method = "GET",
    headers = {},
    body,
    bodyType = "json",
    responseType = "json",
  } = config;
  const schema = options?.schema;

  const fetchHeaders: Record<string, string> = { ...headers };
  let fetchBody: string | undefined;
  if (body !== undefined) {
    if (bodyType === "form") {
      fetchHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      fetchBody =
        typeof body === "string"
          ? body
          : new URLSearchParams(Object.entries(body).map(([k, v]): [string, string] => [k, String(v)])).toString();
    } else {
      fetchHeaders["Content-Type"] = "application/json";
      fetchBody = typeof body === "string" ? body : JSON.stringify(body);
    }
  }

  // Self-contained expression: the config is JSON-embedded directly into the
  // source string rather than passed as an `evaluate` `arg` (see file header —
  // a string pageFunction never receives `arg` from Playwright).
  const cfg = { url, method, headers: fetchHeaders, body: fetchBody, responseType };
  const src = `(async () => {
    const cfg = ${JSON.stringify(cfg)};
    const res = await fetch(cfg.url, { method: cfg.method, headers: cfg.headers, body: cfg.body ?? undefined });
    const status = res.status;
    const ok = res.ok;
    const data = cfg.responseType === "json" ? await res.json() : await res.text();
    return { status, ok, data };
  })()`;

  const result = await page.evaluate<RawEvaluateResult>(src);

  if (!result.ok) {
    throw new Error(`pageRequest failed: ${method} ${url} returned ${result.status}`);
  }

  if (schema) return schema.parse(result.data) as PageRequestResult<T>;
  return result.data as PageRequestResult<T>;
}
