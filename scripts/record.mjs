// Unified recorder for record-by-demonstration: captures BOTH the click sequence
// and the network traffic of a live workflow in ONE persistent-context session,
// then writes a single recording that the flow compiler turns into a draft flow.
//
//   node scripts/record.mjs \
//     --base-url https://mychart.urmc.rochester.edu --profile mychart-urmc --name schedule
//
// Log in, drive the workflow to completion (stop BEFORE booking), press Enter.
// Output: .portico/recordings/<name>.json  →  { baseUrl, clicks[], network[] }
// Then:  compile it into a flow draft (CLI `compile`, coming with the store).
import { createRequire } from "module";
import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(resolve("packages/engine") + "/");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const arg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const baseUrl = arg("--base-url", "");
const profileArg = arg("--profile", "default");
const name = arg("--name", "recording");
const profileName = profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "default";
const userDataDir = resolve(".portico/profiles", `${profileName}.userdata`);

// --- Network capture policy: same as Libretto's (document/xhr/fetch, drop
//     images/fonts/media/stylesheets + analytics/ad noise). ------------------
const LOG_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);
const SKIP_RESOURCE_TYPES = new Set(["image", "font", "media", "stylesheet"]);
const NOISE_URL_RE = /(google-analytics|googletagmanager|googleadservices|googlesyndication|doubleclick|facebook\.com\/tr|pinterest|criteo|snapchat|2mdn\.net|adtrafficquality|safeframe|recaptcha|analytics|beacon|pixel|\/ads?\/|\/collect|\/event|\/pagead\/|\/gmp\/conversion|\/ccm\/|\/rmkt\/|favicon|\.map(?:\?|$))/i;
const TEXT_CONTENT_TYPE_RE = /json|html|text|xml|graphql|javascript|x-www-form-urlencoded/i;
const BODY_PREVIEW_CHARS = 4096;
const MAX_SAVED_BODY_BYTES = 10 * 1024 * 1024;

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

const recDir = resolve(".portico/recordings", name);
const rawNetworkDir = join(recDir, "raw-network");
mkdirSync(recDir, { recursive: true });

const clicks = [];
const network = [];
let netId = 0;

function saveSidecar(id, kind, contentType, body) {
  mkdirSync(rawNetworkDir, { recursive: true });
  const ext = contentType?.includes("json") ? "json" : contentType?.includes("html") ? "html" : "txt";
  const file = `${String(id).padStart(6, "0")}.${kind}.${ext}.gz`;
  writeFileSync(join(rawNetworkDir, file), gzipSync(body));
  return `raw-network/${file}`;
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
      const responseHeaders = response.headers();
      const contentType = responseHeaders["content-type"] ?? null;
      let responseBodyPreview = null, responseBodyBytes = null, responseBodyPath = null;
      if (isTextLike(contentType) && LOG_RESOURCE_TYPES.has(resourceType)) {
        try {
          const body = await response.text();
          responseBodyBytes = Buffer.byteLength(body);
          responseBodyPreview = preview(body);
          if (responseBodyBytes <= MAX_SAVED_BODY_BYTES) responseBodyPath = saveSidecar(id, "response", contentType, body);
        } catch { /* unreadable */ }
      }
      network.push({
        id, method, url, resourceType,
        status: response.status(), contentType,
        requestBodyPreview: req.postData() ? preview(req.postData()) : null,
        responseBodyPreview, responseBodyBytes, responseBodyPath,
      });
    } catch { /* torn down — keep going */ }
  });
}

mkdirSync(userDataDir, { recursive: true });
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1440, height: 900 },
});

// Node-side click sink (survives navigations because the binding is re-exposed
// and the init script re-runs per document).
await context.exposeBinding("__recordClick", (_src, data) => clicks.push(data));
await context.addInitScript(() => {
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      const el =
        (t.closest && t.closest("button,a,[role=button],[role=option],[role=radio],[role=tab],[role=menuitem],label,li")) || t;
      const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
      try {
        // @ts-ignore exposed binding
        window.__recordClick({
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
      } catch { /* binding not ready */ }
    },
    true,
  );
});

const page = context.pages()[0] ?? (await context.newPage());
attachNetwork(page);
context.on("page", (p) => attachNetwork(p));

console.log(`↻ persistent profile: .portico/profiles/${profileName}.userdata`);
console.log("● recording clicks + network — drive the workflow normally");
if (baseUrl) await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\n⏸  Log in + drive the workflow to completion (stop BEFORE booking), then press Enter… ");
rl.close();
await context.close();

const recordingPath = join(recDir, "recording.json");
mkdirSync(dirname(recordingPath), { recursive: true });
writeFileSync(recordingPath, JSON.stringify({ baseUrl, clicks, network }, null, 2));

console.log(`\n✔ recorded ${clicks.length} click(s) + ${network.length} request(s)`);
console.log(`  → ${recordingPath}`);
console.log(`  next: compile it into a flow draft (CLI 'compile', coming online with this phase)`);
process.exit(0);
