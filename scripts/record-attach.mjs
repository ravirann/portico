// CDP-ATTACH recorder for record-by-demonstration.
//
// Unlike scripts/record.mjs (which launches its OWN browser and blocks on
// readline), this attaches over CDP to an ALREADY-RUNNING, already-logged-in
// browser session (started by scripts/serve-browser.mjs / CLI `session-start`)
// and records non-interactively until it receives SIGTERM. That's what lets the
// console drive "Record" against the same session that Validate later uses — you
// log in once, demonstrate, and Stop compiles the capture into a draft.
//
//   node scripts/record-attach.mjs --cdp http://localhost:9222 --name rec_abc123 [--base-url URL]
//
// Writes .portico/recordings/<name>/recording.json → { baseUrl, clicks[], network[] }
// incrementally (survives a hard kill) and once more on SIGTERM.
import { createRequire } from "module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(resolve("packages/engine") + "/");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const arg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const cdp = arg("--cdp", "");
const name = arg("--name", "recording");
const requestedBaseUrl = arg("--base-url", "");
let baseUrl = requestedBaseUrl;
if (!cdp) {
  console.error("record-attach: --cdp <endpoint> is required");
  process.exit(2);
}

const recordingPath = resolve(".portico/recordings", name, "recording.json");
mkdirSync(dirname(recordingPath), { recursive: true });

// --- Network capture policy: same as record.mjs (document/xhr/fetch + writes,
//     drop images/fonts/media/stylesheets + analytics/ad noise). Preview-only —
//     the compiler works off response body previews, so no gzip sidecars. ------
const LOG_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);
const SKIP_RESOURCE_TYPES = new Set(["image", "font", "media", "stylesheet"]);
const NOISE_URL_RE = /(google-analytics|googletagmanager|googleadservices|googlesyndication|doubleclick|facebook\.com\/tr|pinterest|criteo|snapchat|2mdn\.net|adtrafficquality|safeframe|recaptcha|analytics|beacon|pixel|\/ads?\/|\/collect|\/event|\/pagead\/|\/gmp\/conversion|\/ccm\/|\/rmkt\/|favicon|\.map(?:\?|$))/i;
const TEXT_CONTENT_TYPE_RE = /json|html|text|xml|graphql|javascript|x-www-form-urlencoded/i;
const BODY_PREVIEW_CHARS = 4096;
const shouldLog = (method, url, rt) => {
  if (url.startsWith("chrome-extension://")) return false;
  if (NOISE_URL_RE.test(url)) return false;
  if (rt === "ping") return false;
  if (LOG_RESOURCE_TYPES.has(rt)) return true;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  if (SKIP_RESOURCE_TYPES.has(rt)) return false;
  return false;
};
const isTextLike = (ct) => ct != null && TEXT_CONTENT_TYPE_RE.test(ct);
const preview = (s) => s.slice(0, BODY_PREVIEW_CHARS);

const clicks = [];
const network = [];
let netId = 0;
let dirty = true;

function flush() {
  if (!dirty) return;
  try {
    writeFileSync(recordingPath, JSON.stringify({ baseUrl, clicks, network }, null, 2));
    dirty = false;
  } catch {
    /* best-effort — retried on the next tick */
  }
}

// Page-side click hook: a capture-phase listener that buffers serialized clicks
// on window.__porticoClicks. Idempotent per document; polled + drained by Node
// (no exposeBinding — more robust across a CDP-attached connection).
function installClickHook() {
  if (window.__porticoClickHooked) return;
  window.__porticoClickHooked = true;
  window.__porticoClicks = window.__porticoClicks || [];
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      const el =
        (t && t.closest && t.closest("button,a,[role=button],[role=option],[role=radio],[role=tab],[role=menuitem],label,li")) || t;
      if (!el) return;
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
      window.__porticoClicks.push({
        tag: el.tagName,
        role: el.getAttribute && el.getAttribute("role"),
        ariaLabel: el.getAttribute && el.getAttribute("aria-label"),
        text,
        id: el.id || null,
        name: el.getAttribute && el.getAttribute("name"),
        testid: (el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id"))) || null,
        href: el.getAttribute && el.getAttribute("href"),
        url: location.href,
      });
    },
    true,
  );
}

function attachNetwork(page) {
  page.on("response", async (response) => {
    try {
      const req = response.request();
      const url = req.url();
      const method = req.method();
      const resourceType = req.resourceType();
      if (!shouldLog(method, url, resourceType)) return;
      const id = ++netId;
      const contentType = response.headers()["content-type"] ?? null;
      let responseBodyPreview = null;
      let responseBodyBytes = null;
      if (isTextLike(contentType) && LOG_RESOURCE_TYPES.has(resourceType)) {
        try {
          const body = await response.text();
          responseBodyBytes = Buffer.byteLength(body);
          responseBodyPreview = preview(body);
        } catch {
          /* unreadable body */
        }
      }
      network.push({
        id,
        method,
        url,
        resourceType,
        status: response.status(),
        contentType,
        requestBodyPreview: req.postData() ? preview(req.postData()) : null,
        responseBodyPreview,
        responseBodyBytes,
      });
      dirty = true;
    } catch {
      /* torn down — keep going */
    }
  });
}

async function drainClicks(page) {
  try {
    const batch = await page.evaluate(() => {
      const c = window.__porticoClicks || [];
      window.__porticoClicks = [];
      return c;
    });
    if (Array.isArray(batch) && batch.length) {
      clicks.push(...batch);
      dirty = true;
    }
  } catch {
    /* page navigating/closed — try again next tick */
  }
}

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0];
if (!context) {
  console.error("record-attach: no browser context at the CDP endpoint");
  process.exit(1);
}

// Install into future documents, and into every page already open.
await context.addInitScript(installClickHook);
for (const page of context.pages()) {
  attachNetwork(page);
  await page.evaluate(installClickHook).catch(() => {});
  if (!baseUrl) baseUrl = page.url();
}
context.on("page", async (p) => {
  attachNetwork(p);
  await p.evaluate(installClickHook).catch(() => {});
});

// Surface the session's browser so the user can actually demonstrate: the
// window may be buried behind other apps (the recorder attaches silently in the
// background). Navigate to the requested start URL if one was given, then bring
// the window to the front. Best-effort — recording proceeds either way.
{
  const page = context.pages()[0] ?? (await context.newPage().catch(() => null));
  if (page) {
    if (requestedBaseUrl) await page.goto(requestedBaseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.bringToFront().catch(() => {});
    if (!baseUrl) baseUrl = page.url();
  }
}

flush();
console.log(`● attached to ${cdp} — recording clicks + network to ${recordingPath}`);

// Poll open pages, draining their click buffers, and flush the recording.
const poll = setInterval(async () => {
  for (const page of context.pages()) await drainClicks(page);
  flush();
}, 700);

const shutdown = async () => {
  clearInterval(poll);
  for (const page of context.pages()) await drainClicks(page);
  dirty = true;
  flush();
  // Do NOT browser.close() — that could tear down the user's logged-in session.
  // Dropping the CDP connection on process exit leaves the real browser running.
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
