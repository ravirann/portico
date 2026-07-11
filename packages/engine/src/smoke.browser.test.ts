/**
 * Browser-backed smoke suite (ADR-0004's evidence bar for retiring the
 * third-party engine dependency): exercises the REAL `runFlow` entry point
 * against a REAL headless Chromium — launched through `launch.ts`, not a mock — driving
 * small in-test HTTP fixture pages. No page/browser mocking anywhere in this
 * file; every assertion is about what actually happened in a real DOM.
 *
 * Auto-skips cleanly (rather than failing) when Chromium isn't installed on
 * this machine — see the `chromiumSkipReason` probe below. Tests are left to
 * run serially (node:test's default for top-level tests in one file), and
 * each scenario keeps its own timeouts tight so the whole file stays well
 * under the ~90s budget even though every scenario launches its own browser
 * (the same real entry point a production run uses — no shared/pooled browser
 * shortcuts here).
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import type { Flow, Target } from "@portico/flow-spec";
import { runFlow } from "./runner.js";
import { launchEphemeralBrowser } from "./launch.js";
import type { EngineRunOptions, EngineRunResult } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture HTTP server — one small static-ish page per behavior under test.
// Bound with no explicit host so BOTH "127.0.0.1" and "localhost" reach it
// (verified: Node's default bind is dual-stack here) — the egress test uses
// the two different hostname STRINGS as two "origins" for allow-list
// purposes (host-based, not full-origin: same server, same port, different
// hostname). A tiny 1x1 GIF backs the "GET subresources still load" check.
// ---------------------------------------------------------------------------

const PIXEL_GIF = Buffer.from(
  "47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b",
  "hex",
);

let collectCalls = 0;

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

const ROUTES: Record<string, string> = {
  "/form": page(`
    <label for="name-input">Name</label><input id="name-input">
    <label for="email-input">Email</label><input id="email-input">
    <button id="go-btn">Continue</button>
    <div id="confirmation"></div>
    <script>
      document.getElementById('go-btn').addEventListener('click', () => {
        const name = document.getElementById('name-input').value;
        const email = document.getElementById('email-input').value;
        document.getElementById('confirmation').textContent = 'Thanks, ' + name + ' (' + email + ')!';
      });
    </script>
  `),
  "/editor": page(`
    <div id="editor" contenteditable="true" data-mirror=""></div>
    <div id="editor2" contenteditable="true" data-mirror=""></div>
    <script>
      function wireMirror(el) {
        el.addEventListener('keydown', (e) => {
          if (e.key.length === 1) el.setAttribute('data-mirror', (el.getAttribute('data-mirror') || '') + e.key);
        });
      }
      wireMirror(document.getElementById('editor'));
      wireMirror(document.getElementById('editor2'));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) document.body.setAttribute('data-chord', 'fired');
      });
    </script>
  `),
  "/iframe": page(`<iframe id="inner-frame" src="/iframe-inner"></iframe>`),
  "/iframe-inner": page(`<label for="code-input">Code</label><input id="code-input">`),
  "/mutate": page(`
    <button id="delete-btn">Delete the record</button>
    <script>
      document.getElementById('delete-btn').addEventListener('click', () => {
        document.body.setAttribute('data-deleted', '1');
      });
    </script>
  `),
  "/overlay": page(`
    <button id="primary-btn">Do The Thing</button>
    <div id="result"></div>
    <div id="overlay-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center;">
      <div style="background:#fff;padding:16px;">
        <p>Subscribe to our newsletter?</p>
        <button id="overlay-close-btn">Close</button>
      </div>
    </div>
    <script>
      document.getElementById('primary-btn').addEventListener('click', () => {
        document.getElementById('result').setAttribute('data-clicked', '1');
      });
      document.getElementById('overlay-close-btn').addEventListener('click', () => {
        document.getElementById('overlay-backdrop').remove();
      });
    </script>
  `),
  "/egress": page(`
    <form id="f">
      <input type="hidden" name="x" value="1">
      <button id="send-btn" type="submit">Send</button>
    </form>
    <img id="pixel" alt="">
    <div id="status" data-post="pending" data-img="pending"></div>
    <script>
      const disallowed = "http://localhost:" + location.port;
      document.getElementById('f').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await fetch(disallowed + "/collect", { method: "POST", body: "x=1", headers: { "Content-Type": "text/plain" } });
          document.getElementById('status').dataset.post = "sent";
        } catch (err) {
          document.getElementById('status').dataset.post = "blocked";
        }
      });
      const img = document.getElementById('pixel');
      img.addEventListener('load', () => { document.getElementById('status').dataset.img = "loaded"; });
      img.addEventListener('error', () => { document.getElementById('status').dataset.img = "error"; });
      img.src = disallowed + "/pixel.gif";
    </script>
  `),
  "/resume": page(`<label for="greeting-input">Greeting</label><input id="greeting-input">`),
};

function listPage(): string {
  const rows = Array.from({ length: 200 }, (_, i) => `<li><button data-idx="${i}">Row ${i}</button></li>`).join("");
  return page(`
    <ul>${rows}</ul>
    <script>
      document.querySelectorAll('button[data-idx]').forEach((btn) => {
        btn.addEventListener('click', () => document.body.setAttribute('data-clicked', btn.dataset.idx));
      });
    </script>
  `);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/pixel.gif") {
    res.writeHead(200, { "content-type": "image/gif" });
    res.end(PIXEL_GIF);
    return;
  }
  if (url.pathname === "/collect" && req.method === "POST") {
    collectCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/list") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(listPage());
    return;
  }
  const body = ROUTES[url.pathname];
  if (body) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
    return;
  }
  res.writeHead(404);
  res.end("not found");
}

let server: Server | undefined;
let origin = "";

async function startServer(): Promise<string> {
  server = createServer(handleRequest);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

// ---------------------------------------------------------------------------
// Chromium availability probe — determined ONCE (top-level await), before any
// test is registered, so a missing browser skips the whole file cleanly with
// one clear reason instead of every test failing with the same launch error.
// ---------------------------------------------------------------------------

async function probeChromium(): Promise<string | false> {
  try {
    const session = await launchEphemeralBrowser({ headless: true });
    await session.close();
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/executable doesn't exist|playwright install|browserType\.launch/i.test(message)) {
      return `chromium is not installed on this machine — skipping the browser-backed smoke suite (${message.split("\n")[0]})`;
    }
    throw err; // an unexpected failure should not be silently swallowed as "not installed"
  }
}

const chromiumSkipReason = await probeChromium();
if (!chromiumSkipReason) origin = await startServer();

// Without this, the fixture server's open socket keeps the event loop alive
// forever — `node --test` waits for the loop to drain rather than exiting
// once the last test finishes, so the process would hang indefinitely after
// a fully green run instead of exiting.
after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTarget(path: string, allowedDomains: string[] = []): Target {
  return {
    key: "smoke",
    name: "smoke",
    base_url: `${origin}${path}`,
    allowed_domains: allowedDomains,
    auth: "none",
  };
}

/** Thin wrapper over the REAL `runFlow` entry point with fast, hermetic
 *  defaults (headless, no recording/artifacts, no egress unless asked). */
async function run(flow: Flow, target: Target, extra: Partial<EngineRunOptions> = {}): Promise<EngineRunResult> {
  return runFlow({
    flow,
    target,
    inputs: {},
    auth: { secrets: {} },
    mode: "live",
    headless: true,
    record: false,
    ...extra,
  });
}

const skip = chromiumSkipReason;

// ---------------------------------------------------------------------------
// 1) navigate → fill → click → schema-gated extract
// ---------------------------------------------------------------------------

test("navigate, fill, click, and schema-gated extract complete with validated output", { skip }, async () => {
  const target = makeTarget("/form");
  const flow: Flow = {
    key: "form-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      { type: "act", label: "fill name", value: "Ada Lovelace", locator: { semantic: { name: "Name", intent: "the name field" } } },
      { type: "act", label: "fill email", value: "ada@example.com", locator: { semantic: { name: "Email", intent: "the email field" } } },
      { type: "act", label: "continue", locator: { semantic: { role: "button", name: "Continue", intent: "the continue button" } } },
      {
        type: "extract",
        label: "confirmation",
        locator: { cached: "#confirmation", semantic: { intent: "the confirmation message" } },
        extract: { key: "confirmation", schema: { type: "string" } },
      },
    ],
  };
  const result = await run(flow, target);
  assert.equal(result.status, "completed");
  assert.equal(result.output.confirmation, "Thanks, Ada Lovelace (ada@example.com)!");
  assert.ok(!(result.unvalidatedOutputKeys ?? []).includes("confirmation"), "schema should have validated cleanly");
});

// ---------------------------------------------------------------------------
// 2) method press (keyboard chord) + method type into contenteditable
// ---------------------------------------------------------------------------

test("method 'press' fires a real keyboard chord; method 'type' mirrors real key events fill() would miss", { skip }, async () => {
  const target = makeTarget("/editor");
  const flow: Flow = {
    key: "editor-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      { type: "act", label: "chord", method: "press", value: "Control+Enter" },
      {
        type: "act",
        label: "type into editor",
        method: "type",
        value: "hi",
        locator: { cached: "#editor", semantic: { intent: "the rich-text editor" } },
      },
      {
        type: "act",
        label: "fill editor2 (contrast case)",
        method: "fill",
        value: "hi",
        locator: { cached: "#editor2", semantic: { intent: "the second rich-text editor" } },
      },
      { type: "read", label: "read chord", read: { expression: "document.body.getAttribute('data-chord') || ''", as: "chord" } },
      { type: "read", label: "read type mirror", read: { expression: "document.getElementById('editor').getAttribute('data-mirror') || ''", as: "typeMirror" } },
      { type: "read", label: "read fill mirror", read: { expression: "document.getElementById('editor2').getAttribute('data-mirror') || ''", as: "fillMirror" } },
    ],
  };
  const result = await run(flow, target);
  assert.equal(result.status, "completed");
  assert.equal(result.output.chord, "fired", "global keyboard.press should have dispatched a real Control+Enter keydown");
  assert.equal(result.output.typeMirror, "hi", "method:'type' fires real per-character key events");
  assert.equal(result.output.fillMirror, "", "method:'fill' does NOT fire key events — fill() would have left the mirror empty");
});

// ---------------------------------------------------------------------------
// 3) locator.frame chain fills an input inside a nested iframe
// ---------------------------------------------------------------------------

test("locator.frame resolves through an iframe chain and fills the nested input", { skip }, async () => {
  const target = makeTarget("/iframe");
  const flow: Flow = {
    key: "iframe-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      {
        type: "act",
        label: "fill code in iframe",
        value: "XYZ-42",
        locator: { frame: ["#inner-frame"], semantic: { name: "Code", intent: "the code field inside the iframe" } },
      },
      {
        type: "read",
        label: "read iframe input value",
        read: { expression: "document.getElementById('inner-frame').contentDocument.getElementById('code-input').value", as: "codeValue" },
      },
    ],
  };
  const result = await run(flow, target);
  assert.equal(result.status, "completed");
  assert.equal(result.output.codeValue, "XYZ-42");
});

// ---------------------------------------------------------------------------
// 4) below-fold row clicked via the scrollIntoView path
// ---------------------------------------------------------------------------

test("a row far below the fold is scrolled into view and clicked", { skip }, async () => {
  const target = makeTarget("/list");
  const flow: Flow = {
    key: "list-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      { type: "act", label: "click row 150", locator: { semantic: { role: "button", name: "Row 150", intent: "row 150" } } },
      { type: "read", label: "read clicked", read: { expression: "document.body.getAttribute('data-clicked') || ''", as: "clicked" } },
    ],
  };
  const result = await run(flow, target);
  assert.equal(result.status, "completed");
  assert.equal(result.output.clicked, "150");
});

// ---------------------------------------------------------------------------
// 5) dry_run skips a mutating-labeled act; live mode performs it
// ---------------------------------------------------------------------------

test("dry_run skips a mutating act (page unchanged, skippedMutations populated); live performs it", { skip }, async () => {
  const target = makeTarget("/mutate");
  const flow: Flow = {
    key: "mutate-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      {
        type: "act",
        label: "Delete the record",
        locator: { semantic: { role: "button", name: "Delete the record", intent: "the delete button" } },
      },
      { type: "read", label: "read deleted flag", read: { expression: "document.body.getAttribute('data-deleted') || ''", as: "deleted" } },
    ],
  };

  const dryRun = await run(flow, target, { mode: "dry_run" });
  assert.equal(dryRun.status, "completed");
  assert.equal(dryRun.output.deleted, "", "dry_run must never click a mutating act — page state unchanged");
  assert.ok((dryRun.skippedMutations ?? []).length > 0, "the skipped mutation should be recorded on the result");
  assert.match(dryRun.skippedMutations![0]!, /Delete the record/);

  const live = await run(flow, target, { mode: "live" });
  assert.equal(live.status, "completed");
  assert.equal(live.output.deleted, "1", "live mode performs the mutating act");
  assert.equal(live.skippedMutations, undefined);
});

// ---------------------------------------------------------------------------
// 6) egress: cross-origin POST aborted (blockedRequests), GET subresource loads
// ---------------------------------------------------------------------------

test("egress boundary aborts a cross-origin POST but lets a GET subresource load", { skip }, async () => {
  collectCalls = 0;
  // allowedDomains covers ONLY the "127.0.0.1" hostname this page is served
  // from; the page's own script targets "localhost" on the SAME server/port
  // — a different hostname, so a disallowed host for the egress boundary
  // (which is host-based, not full-origin/port-based).
  const target = makeTarget("/egress", ["127.0.0.1"]);
  const pollFor = (selector: string, key: string) =>
    `new Promise((resolve) => { const check = () => { const v = document.querySelector('${selector}').dataset.${key}; ` +
    `if (v && v !== 'pending') resolve(v); else setTimeout(check, 30); }; check(); })`;
  const flow: Flow = {
    key: "egress-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      { type: "act", label: "send", locator: { semantic: { role: "button", name: "Send", intent: "the send button" } } },
      { type: "read", label: "wait for post status", timeoutMs: 5000, read: { expression: pollFor("#status", "post"), as: "postStatus" } },
      { type: "read", label: "wait for img status", timeoutMs: 5000, read: { expression: pollFor("#status", "img"), as: "imgStatus" } },
    ],
  };
  const result = await run(flow, target, { allowedDomains: ["127.0.0.1"] });
  assert.equal(result.status, "completed");
  assert.equal(result.output.postStatus, "blocked", "the cross-origin POST must be aborted before it leaves the browser");
  assert.equal(result.output.imgStatus, "loaded", "a GET subresource to a non-allowed host must still load");
  assert.ok(
    (result.blockedRequests ?? []).some((r) => r.includes("localhost")),
    `expected a blocked "localhost" request, got: ${JSON.stringify(result.blockedRequests)}`,
  );
  assert.equal(collectCalls, 0, "the disallowed origin's /collect endpoint must never actually be hit");
});

// ---------------------------------------------------------------------------
// 7) recovery: an overlay-blocked click heals via deterministic dismissal
// ---------------------------------------------------------------------------

test("an overlay-blocked click heals via deterministic dismissal (no heal model configured)", { skip }, async () => {
  const target = makeTarget("/overlay");
  const flow: Flow = {
    key: "overlay-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" },
      {
        type: "act",
        label: "Do the primary thing",
        // Tight budget: the overlay never goes away on its own, so keep the
        // doomed-to-fail first attempt short instead of eating the 15s default.
        timeoutMs: 1200,
        retry: { max: 0, backoffMs: 0 },
        locator: { semantic: { role: "button", name: "Do The Thing", intent: "the primary action button" } },
      },
      { type: "read", label: "read clicked", read: { expression: "document.getElementById('result').getAttribute('data-clicked') || ''", as: "clicked" } },
    ],
  };
  const result = await run(flow, target);
  assert.equal(result.status, "completed");
  assert.equal(result.output.clicked, "1", "the action should have succeeded after the overlay was dismissed");
  const actTrace = result.traces.find((t) => t.type === "act");
  assert.ok(actTrace, "expected an act trace");
  assert.equal(actTrace!.status, "healed");
  assert.match(actTrace!.detail ?? "", /recovered/i);
});

// ---------------------------------------------------------------------------
// 8) resumeFrom + resumeOutput: a later step templating an earlier output
// ---------------------------------------------------------------------------

test("resumeFrom + resumeOutput: a later step's template resolves from the seeded output", { skip }, async () => {
  const target = makeTarget("/resume");
  const flow: Flow = {
    key: "resume-flow",
    version: 1,
    steps: [
      { type: "navigate", label: "open", url: "{{base_url}}" }, // index 0 — skipped on resume
      { type: "read", label: "seed (unused on resume)", read: { expression: "'not-used'", as: "greeting" } }, // index 1 — skipped
      {
        type: "act",
        label: "fill greeting",
        value: "{{greeting}}",
        locator: { semantic: { name: "Greeting", intent: "the greeting field" } },
      }, // index 2 — the resumed run STARTS here
      { type: "read", label: "confirm", read: { expression: "document.getElementById('greeting-input').value", as: "confirmed" } }, // index 3
    ],
  };
  const result = await run(flow, target, {
    resumeFrom: 2,
    resumeOutput: { greeting: "resumed-hello-42" },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.output.confirmed, "resumed-hello-42", "the resumed step's template should resolve from resumeOutput, not a re-run of step 1");
});
