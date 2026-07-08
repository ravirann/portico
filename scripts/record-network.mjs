// Record the network traffic of a live portal flow, so we can promote a DOM
// flow to direct network requests (the "API tier"). This is Portico's in-process
// equivalent of what `npx libretto run` captures automatically — Libretto's
// network capture lives in its CLI daemon (cli/core/session-telemetry.js), NOT in
// the launchBrowser/workflow library primitives we use, so we attach the same
// listeners ourselves and write a Libretto-compatible network.jsonl.
//
//   node scripts/record-network.mjs \
//     --base-url https://mychart.urmc.rochester.edu \
//     --profile mychart-urmc \
//     --session conversion-flow
//
// Opens the portal (logged in via --profile when the session is still valid),
// you drive the target flow by hand, then press Enter. Every XHR/fetch/document
// request is logged to .libretto/sessions/<session>/network.jsonl (+ gzipped
// bodies under raw-network/), exactly like Libretto's capture. Analyze it with
// scripts/analyze-network.mjs to find the clean JSON endpoints to promote.
import { createRequire } from "module";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(resolve("packages/engine") + "/");
const { launchBrowser } = require("libretto");

const args = process.argv.slice(2);
const arg = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const baseUrl = arg("--base-url", "");
const profileArg = arg("--profile");
const sessionName = arg("--session", "conversion-flow");
const profileName = profileArg ? profileArg.toLowerCase().replace(/[^a-z0-9]+/g, "-") : undefined;
const storageStatePath = profileName ? resolve(".libretto/profiles", `${profileName}.json`) : undefined;
const hasProfile = Boolean(storageStatePath && existsSync(storageStatePath));

// --- Capture policy: identical to Libretto's session-telemetry so the output is
//     directly comparable. Log document/xhr/fetch (and any write method); drop
//     images/fonts/media/stylesheets and analytics/ad/tracker noise.
const LOG_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);
const SKIP_RESOURCE_TYPES = new Set(["image", "font", "media", "stylesheet"]);
const NOISE_URL_RE = /(google-analytics|googletagmanager|googleadservices|googlesyndication|doubleclick|facebook\.com\/tr|pinterest|criteo|snapchat|2mdn\.net|adtrafficquality|safeframe|recaptcha|analytics|beacon|pixel|\/ads?\/|\/collect|\/event|\/pagead\/|\/gmp\/conversion|\/ccm\/|\/rmkt\/|favicon|\.map(?:\?|$))/i;
const TEXT_CONTENT_TYPE_RE = /json|html|text|xml|graphql|javascript|x-www-form-urlencoded/i;
const BODY_PREVIEW_CHARS = 4096;
const MAX_SAVED_BODY_BYTES = 10 * 1024 * 1024;

function shouldLog(method, url, resourceType) {
  if (url.startsWith("chrome-extension://")) return false;
  if (NOISE_URL_RE.test(url)) return false;
  if (resourceType === "ping") return false;
  if (LOG_RESOURCE_TYPES.has(resourceType)) return true;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) return true;
  if (SKIP_RESOURCE_TYPES.has(resourceType)) return false;
  return false;
}
const isTextLike = (ct) => ct != null && TEXT_CONTENT_TYPE_RE.test(ct);
const preview = (s) => s.slice(0, BODY_PREVIEW_CHARS);

const sessionDir = resolve(".libretto/sessions", sessionName);
const jsonlPath = join(sessionDir, "network.jsonl");
const rawNetworkDir = join(sessionDir, "raw-network");
mkdirSync(sessionDir, { recursive: true });
// Truncate any prior capture for this session name.
writeFileSync(jsonlPath, "");

function saveSidecar(id, kind, contentType, body) {
  mkdirSync(rawNetworkDir, { recursive: true });
  const ext = contentType?.includes("json") ? "json" : contentType?.includes("html") ? "html" : "txt";
  const filename = `${String(id).padStart(6, "0")}.${kind}.${ext}.gz`;
  writeFileSync(join(rawNetworkDir, filename), gzipSync(body));
  return `raw-network/${filename}`;
}

let networkId = 0;
let logged = 0;
const emit = (entry) => {
  appendFileSync(jsonlPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  logged++;
};

function attach(page, pageId) {
  page.on("response", async (response) => {
    try {
      const request = response.request();
      const url = request.url();
      const method = request.method();
      const resourceType = request.resourceType();
      if (!shouldLog(method, url, resourceType)) return;
      const id = ++networkId;
      const requestHeaders = request.headers();
      const responseHeaders = response.headers();
      const contentType = responseHeaders["content-type"] ?? null;
      const requestContentType = requestHeaders["content-type"] ?? null;
      const requestBody = request.postData();
      const requestBodyBytes = requestBody == null ? null : Buffer.byteLength(requestBody);

      let requestBodyPath = null, requestBodyOmittedReason = null;
      if (requestBody == null) requestBodyOmittedReason = "no-request-body";
      else if (!isTextLike(requestContentType)) requestBodyOmittedReason = "binary-content-type";
      else if (requestBodyBytes > MAX_SAVED_BODY_BYTES) requestBodyOmittedReason = "body-too-large";
      else requestBodyPath = saveSidecar(id, "request", requestContentType, requestBody);

      let responseBodyPreview = null, responseBodyPath = null, responseBodyBytes = null;
      let responseBodyTruncated = false, responseBodyOmittedReason = null, errorText = null;
      if (!isTextLike(contentType) || !LOG_RESOURCE_TYPES.has(resourceType)) {
        responseBodyOmittedReason = "binary-content-type";
      } else {
        try {
          const responseBody = await response.text();
          responseBodyBytes = Buffer.byteLength(responseBody);
          responseBodyPreview = preview(responseBody);
          if (responseBodyBytes > MAX_SAVED_BODY_BYTES) {
            responseBodyTruncated = true;
            responseBodyOmittedReason = "body-too-large";
          } else {
            responseBodyPath = saveSidecar(id, "response", contentType, responseBody);
          }
        } catch (e) {
          responseBodyOmittedReason = "read-error";
          errorText = e instanceof Error ? e.message : String(e);
        }
      }

      emit({
        id, pageId, method, url, resourceType,
        status: response.status(), statusText: response.statusText(), contentType,
        requestHeaders, responseHeaders,
        requestBodyPreview: requestBody ? preview(requestBody) : null,
        requestBodyPath, requestBodyBytes,
        requestBodyTruncated: requestBody != null && requestBodyBytes != null && requestBodyBytes > MAX_SAVED_BODY_BYTES,
        requestBodyOmittedReason,
        responseBodyPreview, responseBodyPath, responseBodyBytes, responseBodyTruncated, responseBodyOmittedReason,
        errorText,
        postData: requestBody ? preview(requestBody) : undefined,
      });
    } catch {
      /* a torn-down response/page — skip this entry, keep recording */
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    const method = request.method();
    const resourceType = request.resourceType();
    if (!shouldLog(method, url, resourceType)) return;
    const id = ++networkId;
    emit({
      id, pageId, method, url, resourceType,
      status: null, statusText: null, contentType: null,
      requestHeaders: request.headers(), responseHeaders: null,
      requestBodyPreview: null, requestBodyPath: null, requestBodyBytes: null,
      requestBodyTruncated: false, requestBodyOmittedReason: null,
      responseBodyPreview: null, responseBodyPath: null, responseBodyBytes: null,
      responseBodyTruncated: false, responseBodyOmittedReason: "request-failed",
      errorText: request.failure()?.errorText ?? null,
    });
  });
}

const session = await launchBrowser({
  sessionName: `record-${Date.now()}`,
  headless: false,
  viewport: { width: 1440, height: 900 },
  ...(hasProfile ? { storageStatePath } : {}),
});

// Capture the initial page and any popups/tabs the flow opens.
let pageIndex = 0;
attach(session.page, pageIndex);
session.context.on("page", (p) => attach(p, ++pageIndex));

console.log(hasProfile ? `↻ loaded profile ${profileName} (log in if the portal prompts)` : "· no saved profile — log in when the page opens");
console.log(`● recording network → .libretto/sessions/${sessionName}/network.jsonl`);
if (baseUrl) await session.page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\n⏸  Drive the flow to completion (stop BEFORE booking), then press Enter to end the recording… ");
rl.close();

// Persist the refreshed session back to the profile (so a follow-up run is logged in).
if (storageStatePath) {
  try {
    mkdirSync(dirname(storageStatePath), { recursive: true });
    writeFileSync(storageStatePath, JSON.stringify(await session.context.storageState(), null, 2));
    console.log(`✔ saved refreshed session → .libretto/profiles/${profileName}.json`);
  } catch (e) {
    console.log(`✗ could not save session: ${e instanceof Error ? e.message : e}`);
  }
}

await session.close();
console.log(`\n✔ captured ${logged} request(s) → .libretto/sessions/${sessionName}/network.jsonl`);
console.log(`  next: node scripts/analyze-network.mjs --session ${sessionName}`);
process.exit(0);
