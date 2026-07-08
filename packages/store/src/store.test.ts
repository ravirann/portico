import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as storeModule from "./index.js";
import { Store } from "./index.js";
import type { RunView, StepView } from "./index.js";

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "portico-store-"));
  const store = new Store({ dbPath: join(dir, "portico.db"), dataDir: dir });
  return { store, dir };
}

function sampleRun(id: string, steps: StepView[] = []): RunView {
  return {
    id,
    connector: "example",
    flow: "login",
    engine: "direct-api",
    tier: "api",
    status: "running",
    mode: "live",
    startedAt: "2026-07-08T10:00:00.000Z",
    durationMs: 0,
    steps,
    output: { hello: "world" },
  };
}

test("createRun then getRun round-trips a RunView", () => {
  const { store, dir } = freshStore();
  try {
    store.createRun(sampleRun("run-1"));
    const got = store.getRun("run-1");
    assert.ok(got);
    assert.equal(got.id, "run-1");
    assert.equal(got.connector, "example");
    assert.equal(got.tier, "api");
    assert.equal(got.mode, "live");
    assert.equal(got.startedAt, "2026-07-08T10:00:00.000Z");
    assert.deepEqual(got.output, { hello: "world" });
    assert.deepEqual(got.steps, []);
    assert.equal(store.getRun("missing"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateRunStatus patches terminal fields", () => {
  const { store, dir } = freshStore();
  try {
    store.createRun(sampleRun("run-2"));
    store.updateRunStatus("run-2", "failed", 4200, { partial: true }, { stepIndex: 1, reason: "boom" }, "artifacts/rec.json");
    const got = store.getRun("run-2");
    assert.ok(got);
    assert.equal(got.status, "failed");
    assert.equal(got.durationMs, 4200);
    assert.deepEqual(got.output, { partial: true });
    assert.deepEqual(got.failure, { stepIndex: 1, reason: "boom" });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addRunSteps then getRun returns the steps in order", () => {
  const { store, dir } = freshStore();
  try {
    store.createRun(sampleRun("run-3"));
    const steps: StepView[] = [
      { index: 0, type: "navigate", label: "open", status: "ok", durationMs: 12 },
      { index: 1, type: "fill", status: "healed", detail: "selector drift", durationMs: 30 },
      { index: 2, type: "extract", status: "ok", durationMs: 5 },
    ];
    store.addRunSteps("run-3", steps);
    const got = store.getRun("run-3");
    assert.ok(got);
    assert.equal(got.steps.length, 3);
    assert.deepEqual(got.steps, steps);
    assert.equal(got.steps[1]?.status, "healed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRuns returns most-recent first", () => {
  const { store, dir } = freshStore();
  try {
    store.createRun(sampleRun("run-a"));
    store.createRun(sampleRun("run-b"));
    const ids = store.listRuns().map((r) => r.id);
    assert.deepEqual(ids, ["run-b", "run-a"]);
    assert.equal(store.listRuns(1).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit is append-only: no update/delete surface for audit", () => {
  const { store, dir } = freshStore();
  try {
    store.appendAudit({ actor: "alice", action: "run.start", runId: "run-1", detail: { ip: "127.0.0.1" } });
    store.appendAudit({ actor: "bob", action: "run.approve", runId: "run-1" });
    store.appendAudit({ actor: "alice", action: "run.start", runId: "run-2" });

    const all = store.listAudit();
    assert.equal(all.length, 3);
    // newest first, resolved id + ts
    assert.equal(all[0]?.action, "run.start");
    assert.ok(all[0]?.ts);
    assert.ok(typeof all[0]?.id === "number");

    // filters
    assert.equal(store.listAudit({ runId: "run-1" }).length, 2);
    assert.equal(store.listAudit({ actor: "bob" }).length, 1);
    assert.equal(store.listAudit({ action: "run.start" }).length, 2);
    assert.deepEqual(store.listAudit({ runId: "run-1", actor: "alice" })[0]?.detail, { ip: "127.0.0.1" });

    // The only audit-related exports are appendAudit + listAudit — assert no
    // update/delete/remove path leaks through the module or the Store prototype.
    const moduleNames = Object.keys(storeModule);
    const protoNames = Object.getOwnPropertyNames(Store.prototype);
    const auditNames = [...moduleNames, ...protoNames].filter((n) => /audit/i.test(n));
    assert.deepEqual(auditNames.sort(), ["appendAudit", "listAudit"]);
    for (const n of [...moduleNames, ...protoNames]) {
      assert.doesNotMatch(n, /audit.*(update|delete|remove)|(update|delete|remove).*audit/i);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session save/get round-trips through the base64 cipher and stores ciphertext", () => {
  const { store, dir } = freshStore();
  try {
    const state = JSON.stringify({ cookies: [{ name: "sid", value: "s3cr3t" }] });
    store.saveSession("tenant-x", "portal/user", state);
    assert.equal(store.getSession("tenant-x", "portal/user"), state);
    assert.equal(store.getSession("tenant-x", "other"), undefined);

    // upsert: second save overwrites
    store.saveSession("tenant-x", "portal/user", "updated");
    assert.equal(store.getSession("tenant-x", "portal/user"), "updated");

    // at-rest value is base64-encoded (not plaintext) — read the raw column
    const raw = new Store({ dbPath: join(dir, "portico.db"), dataDir: dir });
    try {
      const encoded = Buffer.from("updated", "utf8").toString("base64");
      const decoded = raw.getSession("tenant-x", "portal/user");
      assert.equal(decoded, "updated");
      assert.notEqual(encoded, "updated"); // sanity: encoding actually changes it
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveArtifact returns a relative ref that getArtifactPath resolves", () => {
  const { store, dir } = freshStore();
  try {
    const ref = store.saveArtifact("<html></html>", "html");
    assert.match(ref, /^artifacts[\\/].+\.html$/);
    const abs = store.getArtifactPath(ref);
    assert.ok(abs.startsWith(dir));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveFlow then getFlow round-trips all fields", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({
      id: "flow-1",
      key: "portal-availability",
      version: 1,
      yaml: "steps: []",
      status: "draft",
      source: "recorded",
      connector: "example-portal",
      createdAt: "2026-07-08T10:00:00.000Z",
    });
    const got = store.getFlow("flow-1");
    assert.ok(got);
    assert.equal(got.id, "flow-1");
    assert.equal(got.key, "portal-availability");
    assert.equal(got.version, 1);
    assert.equal(got.yaml, "steps: []");
    assert.equal(got.status, "draft");
    assert.equal(got.source, "recorded");
    assert.equal(got.connector, "example-portal");
    assert.equal(got.createdAt, "2026-07-08T10:00:00.000Z");
    assert.equal(store.getFlow("missing"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFlowVersions returns versions newest-first for a key", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({
      id: "flow-a-1",
      key: "portal-availability",
      version: 1,
      yaml: "v1",
      status: "confirmed",
      source: "manual",
      createdAt: "2026-07-08T10:00:00.000Z",
    });
    store.saveFlow({
      id: "flow-a-2",
      key: "portal-availability",
      version: 2,
      yaml: "v2",
      status: "draft",
      source: "llm",
      createdAt: "2026-07-08T11:00:00.000Z",
    });
    store.saveFlow({
      id: "flow-b-1",
      key: "other-flow",
      version: 1,
      yaml: "v1",
      status: "draft",
      source: "manual",
      createdAt: "2026-07-08T10:00:00.000Z",
    });
    const versions = store.listFlowVersions("portal-availability");
    assert.deepEqual(
      versions.map((f) => f.version),
      [2, 1],
    );
    assert.equal(store.listFlowVersions("missing-key").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmFlow flips status; latestConfirmedFlow ignores drafts and picks the highest version", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({
      id: "flow-c-1",
      key: "portal-checkout",
      version: 1,
      yaml: "v1",
      status: "confirmed",
      source: "manual",
      createdAt: "2026-07-08T10:00:00.000Z",
    });
    store.saveFlow({
      id: "flow-c-2",
      key: "portal-checkout",
      version: 2,
      yaml: "v2",
      status: "draft",
      source: "llm",
      createdAt: "2026-07-08T11:00:00.000Z",
    });
    // Only version 1 is confirmed so far.
    assert.equal(store.latestConfirmedFlow("portal-checkout")?.version, 1);

    store.confirmFlow("flow-c-2");
    assert.equal(store.getFlow("flow-c-2")?.status, "confirmed");
    assert.equal(store.latestConfirmedFlow("portal-checkout")?.version, 2);

    assert.equal(store.latestConfirmedFlow("no-such-key"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createBrowserSession then getBrowserSession round-trips", () => {
  const { store, dir } = freshStore();
  try {
    store.createBrowserSession({
      id: "bsess-1",
      tenant: "tenant-x",
      profile: "portal/user",
      cdpEndpoint: "http://localhost:9222",
      startedAt: "2026-07-08T10:00:00.000Z",
    });
    const got = store.getBrowserSession("bsess-1");
    assert.ok(got);
    assert.equal(got.id, "bsess-1");
    assert.equal(got.tenant, "tenant-x");
    assert.equal(got.profile, "portal/user");
    assert.equal(got.cdpEndpoint, "http://localhost:9222");
    assert.equal(got.status, "active");
    assert.equal(got.startedAt, "2026-07-08T10:00:00.000Z");
    assert.equal(got.lastActiveAt, "2026-07-08T10:00:00.000Z");
    assert.equal(store.getBrowserSession("missing"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("touchBrowserSession updates last_active_at; closeBrowserSession sets status closed", () => {
  const { store, dir } = freshStore();
  try {
    store.createBrowserSession({
      id: "bsess-2",
      tenant: "tenant-x",
      startedAt: "2026-07-08T10:00:00.000Z",
    });
    store.touchBrowserSession("bsess-2", "2026-07-08T10:05:00.000Z");
    let got = store.getBrowserSession("bsess-2");
    assert.equal(got?.lastActiveAt, "2026-07-08T10:05:00.000Z");
    assert.equal(got?.status, "active");

    // no-op on an unknown id
    store.touchBrowserSession("missing", "2026-07-08T10:06:00.000Z");
    assert.equal(store.getBrowserSession("missing"), undefined);

    store.closeBrowserSession("bsess-2", "2026-07-08T10:10:00.000Z");
    got = store.getBrowserSession("bsess-2");
    assert.equal(got?.status, "closed");
    assert.equal(got?.lastActiveAt, "2026-07-08T10:10:00.000Z");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listBrowserSessions orders active-first and filters by tenant", () => {
  const { store, dir } = freshStore();
  try {
    store.createBrowserSession({
      id: "bsess-old-active",
      tenant: "tenant-x",
      startedAt: "2026-07-08T09:00:00.000Z",
    });
    store.createBrowserSession({
      id: "bsess-closed",
      tenant: "tenant-x",
      startedAt: "2026-07-08T09:30:00.000Z",
    });
    store.closeBrowserSession("bsess-closed", "2026-07-08T09:45:00.000Z");
    store.createBrowserSession({
      id: "bsess-new-active",
      tenant: "tenant-x",
      startedAt: "2026-07-08T10:00:00.000Z",
    });
    store.createBrowserSession({
      id: "bsess-other-tenant",
      tenant: "tenant-y",
      startedAt: "2026-07-08T11:00:00.000Z",
    });

    const all = store.listBrowserSessions("tenant-x").map((s) => s.id);
    assert.deepEqual(all, ["bsess-new-active", "bsess-old-active", "bsess-closed"]);

    const everyone = store.listBrowserSessions();
    assert.equal(everyone.length, 4);

    const other = store.listBrowserSessions("tenant-y").map((s) => s.id);
    assert.deepEqual(other, ["bsess-other-tenant"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validations: recordValidation then latestValidation returns the newest, with reasons", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({ id: "f1", key: "k", version: 1, yaml: "key: k", status: "draft", source: "recorded", createdAt: "2026-07-08T10:00:00.000Z" });
    assert.equal(store.latestValidation("f1"), undefined);

    store.recordValidation({ id: "v1", flowId: "f1", passed: false, reasons: ["output 'x' missing"], runId: "run_1", createdAt: "2026-07-08T10:00:00.000Z" });
    store.recordValidation({ id: "v2", flowId: "f1", passed: true, reasons: [], runId: "run_2", createdAt: "2026-07-08T10:05:00.000Z" });

    const latest = store.latestValidation("f1")!;
    assert.equal(latest.id, "v2");
    assert.equal(latest.passed, true);
    assert.equal(latest.runId, "run_2");
    assert.deepEqual(latest.reasons, []);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFlows returns recent flows newest-first across keys", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({ id: "a", key: "alpha", version: 1, yaml: "x", status: "draft", source: "recorded", createdAt: "2026-07-08T10:00:00.000Z" });
    store.saveFlow({ id: "b", key: "beta", version: 1, yaml: "x", status: "confirmed", source: "llm", createdAt: "2026-07-08T11:00:00.000Z" });
    const flows = store.listFlows(10).map((f) => f.id);
    assert.deepEqual(flows, ["b", "a"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
