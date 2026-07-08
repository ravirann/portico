// Analyze a Libretto-format `network.jsonl` capture and surface the CLEAN API
// endpoints that are candidates for promoting a DOM browser flow to direct
// network requests (the "API tier"). This is the "analyze traffic" step of
// Libretto's convert-to-network-requests workflow. Output is plain text for a
// human deciding which endpoints to promote — no external dependencies.
//
//   node scripts/analyze-network.mjs --session conversion-flow
//   node scripts/analyze-network.mjs --file .libretto/sessions/foo/network.jsonl
//
// Notes:
//  - `--session <name>` reads `.libretto/sessions/<name>/network.jsonl` (default
//    session name: "conversion-flow"). `--file <path>` points at an explicit
//    file instead. Both are resolved relative to process.cwd().
//  - Malformed JSON lines are skipped and counted rather than crashing the run.
//  - Large response bodies may be spilled to a gzipped sidecar file referenced
//    by `responseBodyPath` (relative to the session directory) instead of an
//    inline `responseBodyPreview`. We gunzip and peek at those when easy.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { gunzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const sessionName = arg("--session") ?? "conversion-flow";
const fileArg = arg("--file");
const networkFilePath = fileArg
  ? resolve(process.cwd(), fileArg)
  : resolve(process.cwd(), ".libretto/sessions", sessionName, "network.jsonl");
const sessionDir = dirname(networkFilePath);

if (!existsSync(networkFilePath)) {
  console.error(`✗ network capture not found: ${networkFilePath}`);
  console.error(
    fileArg
      ? "  (checked the path passed via --file)"
      : `  (checked default location for session "${sessionName}"; pass --file <path> for a custom location)`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse network.jsonl — one JSON object per line, defensively
// ---------------------------------------------------------------------------
const raw = readFileSync(networkFilePath, "utf8");
const lines = raw.split("\n");

const entries = [];
let malformedCount = 0;
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue; // blank line
  try {
    entries.push(JSON.parse(trimmed));
  } catch {
    malformedCount++;
  }
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

// Endpoints that look like the availability/scheduling reads we actually want
// to promote to the API tier — ranked to the top and starred.
const RELEVANCE_REGEX = /slot|appoint|avail|opening|schedul|visit|provider|department|specialt|location/i;

// URL/path shapes that indicate a write (booking, reserving, confirming, etc).
// These commonly carry rotating CSRF / anti-forgery / time-bound slot tokens
// and should stay on the resilient DOM path rather than being blindly replayed.
const MUTATION_REGEX = /reserve|book|schedul|confirm|verify|submit|create|commit/i;

function isJsonLike(contentType) {
  return typeof contentType === "string" && /json|graphql/i.test(contentType);
}

function hasRequestBody(entry) {
  return Boolean(
    entry.requestBodyPreview ||
      entry.requestBodyPath ||
      (typeof entry.requestBodyBytes === "number" && entry.requestBodyBytes > 0) ||
      entry.postData
  );
}

// Split a URL into host + pathname (query stripped) so repeated calls with
// different query strings collapse into one group. Falls back gracefully if
// the URL fails to parse.
function splitUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl) return { host: "", pathname: "(no url)" };
  try {
    const u = new URL(rawUrl);
    return { host: u.host, pathname: u.pathname || "/" };
  } catch {
    return { host: "", pathname: rawUrl };
  }
}

// Collapse to a single line and cap length for compact listing.
function truncateOneLine(str, max) {
  if (typeof str !== "string") return "";
  const oneLine = str.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function isMutationMethod(method) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method).toUpperCase());
}

function looksLikeMutation(entry, pathname) {
  if (!isMutationMethod(entry.method)) return false;
  return MUTATION_REGEX.test(pathname) || hasRequestBody(entry);
}

function is2xx(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

// ---------------------------------------------------------------------------
// Bucket entries into clean-read candidates and mutations
// ---------------------------------------------------------------------------

const cleanReadGroups = new Map(); // key -> group
const mutationEntries = [];

for (const entry of entries) {
  const { host, pathname } = splitUrl(entry.url);
  const method = String(entry.method ?? "").toUpperCase();
  const resourceType = String(entry.resourceType ?? "").toLowerCase();

  if (isMutationMethod(method) && looksLikeMutation(entry, pathname)) {
    mutationEntries.push({ entry, host, pathname, method });
    continue;
  }

  const isXhrOrFetch = resourceType === "xhr" || resourceType === "fetch";
  const qualifiesAsCleanRead =
    is2xx(entry.status) && isJsonLike(entry.contentType) && isXhrOrFetch && (method === "GET" || method === "POST");

  if (!qualifiesAsCleanRead) continue;

  const key = `${method} ${host}${pathname}`;
  const preview = entry.responseBodyPreview ?? null;
  const star = RELEVANCE_REGEX.test(pathname) || (preview ? RELEVANCE_REGEX.test(preview) : false);

  let group = cleanReadGroups.get(key);
  if (!group) {
    group = {
      method,
      host,
      pathname,
      contentType: entry.contentType ?? "",
      count: 0,
      status: entry.status,
      sampleEntry: entry,
      star: false,
    };
    cleanReadGroups.set(key, group);
  }
  group.count++;
  group.star = group.star || star;
  // Prefer a sample entry that actually has a preview/body path to show later.
  if (!group.sampleEntry.responseBodyPreview && !group.sampleEntry.responseBodyPath) {
    group.sampleEntry = entry;
  }
}

// ---------------------------------------------------------------------------
// Sort: starred (relevant) endpoints to the top, GET before POST within that,
// then by hit count descending, then alphabetically for stability.
// ---------------------------------------------------------------------------
const methodRank = (m) => (m === "GET" ? 0 : 1);
const sortedCleanReads = [...cleanReadGroups.values()].sort((a, b) => {
  if (a.star !== b.star) return a.star ? -1 : 1;
  if (methodRank(a.method) !== methodRank(b.method)) return methodRank(a.method) - methodRank(b.method);
  if (b.count !== a.count) return b.count - a.count;
  return `${a.host}${a.pathname}`.localeCompare(`${b.host}${b.pathname}`);
});

// ---------------------------------------------------------------------------
// Read the full response body for a group's sample entry, following the
// gzipped sidecar file if there's no inline preview.
// ---------------------------------------------------------------------------
function fullBodyFor(sampleEntry) {
  if (sampleEntry.responseBodyPreview) {
    return { text: sampleEntry.responseBodyPreview, source: "inline preview" };
  }
  if (sampleEntry.responseBodyPath) {
    const sidecarPath = resolve(sessionDir, sampleEntry.responseBodyPath);
    try {
      const gz = readFileSync(sidecarPath);
      const text = gunzipSync(gz).toString("utf8");
      return { text, source: `gunzipped sidecar: ${sampleEntry.responseBodyPath}` };
    } catch (e) {
      return {
        text: null,
        source: `full body is in gzipped sidecar at ${sampleEntry.responseBodyPath} (relative to session dir) — could not read/gunzip it here: ${
          e instanceof Error ? e.message : e
        }`,
      };
    }
  }
  return { text: null, source: "no preview or sidecar available" };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const rule = "─".repeat(72);

console.log(rule);
console.log("NETWORK ANALYSIS");
console.log(rule);
console.log(`source:            ${networkFilePath}`);
console.log(`entries parsed:    ${entries.length}`);
console.log(`lines skipped:     ${malformedCount} (malformed JSON)`);

console.log(`\n${rule}`);
console.log("CLEAN READ CANDIDATES (promote to API tier)");
console.log(rule);
if (sortedCleanReads.length === 0) {
  console.log("(none found — no 2xx JSON/GraphQL xhr|fetch GET or plain POST responses)");
} else {
  console.log(
    "GET/POST requests returning 2xx JSON (or GraphQL). ★ = path or response body matches\n" +
      "slot/appointment/availability/schedule/provider/department/specialty/location terms —\n" +
      "these are the likely availability/scheduling reads to promote first.\n"
  );
  for (const group of sortedCleanReads) {
    const preview = group.sampleEntry.responseBodyPreview
      ? truncateOneLine(group.sampleEntry.responseBodyPreview, 200)
      : group.sampleEntry.responseBodyPath
      ? `(body in sidecar: ${group.sampleEntry.responseBodyPath})`
      : "(no response body captured)";
    const size =
      typeof group.sampleEntry.responseBodyBytes === "number"
        ? `${group.sampleEntry.responseBodyBytes}B`
        : group.sampleEntry.responseBodyPreview
        ? `${group.sampleEntry.responseBodyPreview.length}B (preview)`
        : "n/a";

    const marker = group.star ? "★" : " ";
    console.log(`[${marker}] ${group.method.padEnd(4)} ${group.host}${group.pathname}`);
    console.log(
      `      status ${group.status ?? "?"}  contentType=${group.contentType || "?"}  hits=${group.count}  size=${size}`
    );
    console.log(`      → ${preview}`);
  }
}

console.log(`\n${rule}`);
console.log("MUTATIONS (keep on DOM — token-bound, do NOT blindly replay)");
console.log(rule);
console.log(
  "Note: these commonly carry rotating CSRF / anti-forgery / time-bound slot tokens\n" +
    "and should stay on the resilient DOM path rather than being replayed directly.\n"
);
if (mutationEntries.length === 0) {
  console.log("(none found)");
} else {
  for (const { entry, host, pathname, method } of mutationEntries) {
    console.log(
      `${method.padEnd(6)} ${host}${pathname}   status=${entry.status ?? "?"}  body=${hasRequestBody(entry) ? "yes" : "no"}`
    );
  }
}

const starred = sortedCleanReads.filter((g) => g.star);
console.log(`\n${rule}`);
console.log("DETAIL DUMP — starred candidates (full response body, up to 1500 chars)");
console.log(rule);
if (starred.length === 0) {
  console.log("(no starred candidates to detail)");
} else {
  for (const group of starred) {
    console.log(`\n${group.method} ${group.host}${group.pathname}`);
    console.log("-".repeat(72));
    const { text, source } = fullBodyFor(group.sampleEntry);
    if (text) {
      console.log(text.length > 1500 ? `${text.slice(0, 1500)}…` : text);
      if (source !== "inline preview") console.log(`\n(source: ${source})`);
    } else {
      console.log(`(no body available — ${source})`);
    }
  }
}

console.log(`\n${rule}`);
process.exit(0);
