import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import BetterSqlite3 from "better-sqlite3";

import * as storeModule from "./index.js";
import { Store, hashMemberToken } from "./index.js";
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

test("appendAudit then listAudit returns newest-first with fields intact", () => {
  const { store, dir } = freshStore();
  try {
    store.appendAudit({
      ts: "2026-07-08T10:00:00.000Z",
      actor: "alice",
      action: "flow.deleted",
      target: "portal-availability",
      detail: { versions: 2 },
    });
    store.appendAudit({
      ts: "2026-07-08T10:05:00.000Z",
      actor: "bob",
      action: "run.completed",
      runId: "run-9",
      target: "https://example.test",
      detail: { mode: "live" },
    });

    const rows = store.listAudit();
    assert.equal(rows.length, 2);

    // newest first
    assert.equal(rows[0]?.action, "run.completed");
    assert.equal(rows[1]?.action, "flow.deleted");

    const newest = rows[0]!;
    assert.equal(typeof newest.id, "number");
    assert.equal(newest.ts, "2026-07-08T10:05:00.000Z");
    assert.equal(newest.actor, "bob");
    assert.equal(newest.runId, "run-9");
    assert.equal(newest.target, "https://example.test");
    assert.deepEqual(newest.detail, { mode: "live" });

    assert.equal(store.listAudit({ limit: 1 }).length, 1);
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

test("saveFlow provenance round-trips through getFlow; flows saved without it have none", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({
      id: "flow-prov-1",
      key: "portal-availability",
      version: 1,
      yaml: "steps: []",
      status: "draft",
      source: "authored",
      provenance: { provider: "openai", model: "gpt-5.5", promptVersion: 1, authorVersion: "0.0.0" },
      createdAt: "2026-07-08T10:00:00.000Z",
    });
    const got = store.getFlow("flow-prov-1");
    assert.ok(got);
    assert.deepEqual(got.provenance, { provider: "openai", model: "gpt-5.5", promptVersion: 1, authorVersion: "0.0.0" });

    store.saveFlow({
      id: "flow-no-prov",
      key: "portal-availability",
      version: 2,
      yaml: "steps: []",
      status: "draft",
      source: "recorded",
      createdAt: "2026-07-08T11:00:00.000Z",
    });
    const noProv = store.getFlow("flow-no-prov");
    assert.ok(noProv);
    assert.equal(noProv.provenance, undefined);
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

test("deleteFlow removes one version (and its validations) but leaves siblings", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({ id: "del-1", key: "del-key", version: 1, yaml: "v1", status: "draft", source: "manual", createdAt: "2026-07-08T10:00:00.000Z" });
    store.saveFlow({ id: "del-2", key: "del-key", version: 2, yaml: "v2", status: "draft", source: "llm", createdAt: "2026-07-08T11:00:00.000Z" });
    store.recordValidation({ id: "del-v1", flowId: "del-1", passed: true, reasons: [], createdAt: "2026-07-08T10:30:00.000Z" });

    store.deleteFlow("del-1");
    assert.equal(store.getFlow("del-1"), undefined);
    assert.equal(store.latestValidation("del-1"), undefined);
    // sibling version untouched
    assert.equal(store.getFlow("del-2")?.version, 2);
    assert.deepEqual(store.listFlowVersions("del-key").map((f) => f.id), ["del-2"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteFlowKey removes all versions and cascades validations; returns count", () => {
  const { store, dir } = freshStore();
  try {
    store.saveFlow({ id: "dk-1", key: "dk-key", version: 1, yaml: "v1", status: "confirmed", source: "manual", createdAt: "2026-07-08T10:00:00.000Z" });
    store.saveFlow({ id: "dk-2", key: "dk-key", version: 2, yaml: "v2", status: "draft", source: "llm", createdAt: "2026-07-08T11:00:00.000Z" });
    store.saveFlow({ id: "other-1", key: "other-key", version: 1, yaml: "v1", status: "draft", source: "manual", createdAt: "2026-07-08T10:00:00.000Z" });
    store.recordValidation({ id: "dk-v1", flowId: "dk-1", passed: false, reasons: ["nope"], createdAt: "2026-07-08T10:30:00.000Z" });
    store.recordValidation({ id: "dk-v2", flowId: "dk-2", passed: true, reasons: [], createdAt: "2026-07-08T11:30:00.000Z" });

    const deleted = store.deleteFlowKey("dk-key");
    assert.equal(deleted, 2);
    assert.equal(store.getFlow("dk-1"), undefined);
    assert.equal(store.getFlow("dk-2"), undefined);
    assert.equal(store.listFlowVersions("dk-key").length, 0);
    // validations cascaded
    assert.equal(store.latestValidation("dk-1"), undefined);
    assert.equal(store.latestValidation("dk-2"), undefined);
    // unrelated key untouched
    assert.equal(store.getFlow("other-1")?.key, "other-key");
    // deleting a missing key reports zero rows
    assert.equal(store.deleteFlowKey("no-such-key"), 0);
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

test("connectors: save then get (by id and key), list, delete round-trip incl. variables", () => {
  const { store, dir } = freshStore();
  try {
    store.saveConnector({
      id: "conn_1",
      key: "example-portal",
      name: "Example Portal",
      framework: "playwright",
      baseUrl: "https://example.test",
      auth: "form",
      variables: { region: "us-east", tier: "gold" },
      createdAt: "2026-07-08T10:00:00.000Z",
      updatedAt: "2026-07-08T10:00:00.000Z",
    });
    store.saveConnector({
      id: "conn_2",
      key: "alpha-portal",
      name: "Alpha Portal",
      createdAt: "2026-07-08T10:00:00.000Z",
      updatedAt: "2026-07-08T10:00:00.000Z",
    });

    const byId = store.getConnector("conn_1");
    assert.ok(byId);
    assert.equal(byId.key, "example-portal");
    assert.equal(byId.name, "Example Portal");
    assert.equal(byId.framework, "playwright");
    assert.equal(byId.baseUrl, "https://example.test");
    assert.equal(byId.auth, "form");
    assert.deepEqual(byId.variables, { region: "us-east", tier: "gold" });

    const byKey = store.getConnector("example-portal");
    assert.ok(byKey);
    assert.equal(byKey.id, "conn_1");

    assert.equal(store.getConnector("missing"), undefined);

    const listed = store.listConnectors().map((c) => c.name);
    assert.deepEqual(listed, ["Alpha Portal", "Example Portal"]); // name asc

    store.deleteConnector("conn_1");
    assert.equal(store.getConnector("conn_1"), undefined);
    assert.equal(store.getConnector("example-portal"), undefined);
    assert.equal(store.listConnectors().length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("connectors: saveConnector upserts by id", () => {
  const { store, dir } = freshStore();
  try {
    store.saveConnector({
      id: "conn_1",
      key: "example-portal",
      name: "Example Portal",
      createdAt: "2026-07-08T10:00:00.000Z",
      updatedAt: "2026-07-08T10:00:00.000Z",
    });
    store.saveConnector({
      id: "conn_1",
      key: "example-portal",
      name: "Example Portal Renamed",
      baseUrl: "https://updated.test",
      createdAt: "2026-07-08T10:00:00.000Z",
      updatedAt: "2026-07-08T11:00:00.000Z",
    });
    const got = store.getConnector("conn_1");
    assert.equal(got?.name, "Example Portal Renamed");
    assert.equal(got?.baseUrl, "https://updated.test");
    assert.equal(store.listConnectors().length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: plaintext values round-trip via getConfig/getConfigValue", () => {
  const { store, dir } = freshStore();
  try {
    store.setConfig({ scope: "global", category: "llm", key: "provider", value: "anthropic" });
    store.setConfig({ scope: "global", category: "llm", key: "model", value: "claude-sonnet" });
    store.setConfig({ scope: "example-portal", category: "variable", key: "region", value: "us-east" });

    assert.equal(store.getConfigValue("global", "llm", "provider"), "anthropic");
    const llmEntries = store.getConfig("global", "llm");
    assert.equal(llmEntries.length, 2);
    assert.deepEqual(
      llmEntries.map((e) => e.key),
      ["model", "provider"],
    );
    assert.equal(llmEntries.every((e) => e.secret === false), true);

    const allGlobal = store.getConfig("global");
    assert.equal(allGlobal.length, 2);

    const scoped = store.getConfig("example-portal", "variable");
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.value, "us-east");

    assert.equal(store.getConfigValue("missing-scope", "llm", "provider"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: secret values are encrypted at rest but decrypted on read", () => {
  const { store, dir } = freshStore();
  try {
    store.setConfig({ scope: "global", category: "llm", key: "api-key", value: "sk-super-secret", secret: true });

    assert.equal(store.getConfigValue("global", "llm", "api-key"), "sk-super-secret");
    const entries = store.getConfig("global", "llm");
    assert.equal(entries[0]?.value, "sk-super-secret");
    assert.equal(entries[0]?.secret, true);

    // the stored column is ciphertext, not plaintext — inspect it directly.
    const raw = new BetterSqlite3(join(dir, "portico.db"));
    try {
      const row = raw
        .prepare("SELECT value FROM app_config WHERE scope = ? AND category = ? AND key = ?")
        .get("global", "llm", "api-key") as { value: string };
      assert.notEqual(row.value, "sk-super-secret");
    } finally {
      raw.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: setConfig upserts by (scope, category, key); deleteConfig removes", () => {
  const { store, dir } = freshStore();
  try {
    store.setConfig({ scope: "global", category: "variable", key: "greeting", value: "hello" });
    store.setConfig({ scope: "global", category: "variable", key: "greeting", value: "goodbye" });
    assert.equal(store.getConfigValue("global", "variable", "greeting"), "goodbye");
    assert.equal(store.getConfig("global", "variable").length, 1);

    store.deleteConfig("global", "variable", "greeting");
    assert.equal(store.getConfigValue("global", "variable", "greeting"), undefined);
    assert.equal(store.getConfig("global", "variable").length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run queue: enqueueRun then claimNextQueued returns the oldest row and flips it to running with worker set", () => {
  const { store, dir } = freshStore();
  try {
    store.enqueueRun({ id: "q-1", flowId: "flows/a.yaml", inputs: { a: "1" } });
    store.enqueueRun({ id: "q-2", flowId: "flows/b.yaml" });

    const claimed = store.claimNextQueued("worker-1");
    assert.ok(claimed);
    assert.equal(claimed.id, "q-1"); // oldest enqueued wins
    assert.equal(claimed.flowId, "flows/a.yaml");
    assert.deepEqual(claimed.inputs, { a: "1" });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.worker, "worker-1");
    assert.ok(claimed.startedAt);

    // the flip is durable — a fresh read agrees.
    const row = store.listQueue({ status: "running" })[0];
    assert.equal(row?.id, "q-1");
    assert.equal(store.listQueue({ status: "queued" }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run queue: a second claim skips the already-claimed row and returns undefined once empty", () => {
  const { store, dir } = freshStore();
  try {
    store.enqueueRun({ id: "q-1", flowId: "flows/a.yaml" });
    store.enqueueRun({ id: "q-2", flowId: "flows/b.yaml" });

    const first = store.claimNextQueued("worker-1");
    const second = store.claimNextQueued("worker-1");
    assert.equal(first?.id, "q-1");
    assert.equal(second?.id, "q-2");

    // queue is now exhausted
    assert.equal(store.claimNextQueued("worker-1"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run queue: sequential claims (simulating multiple workers) never return the same row", () => {
  const { store, dir } = freshStore();
  try {
    for (let i = 0; i < 5; i++) store.enqueueRun({ id: `q-${i}`, flowId: `flows/${i}.yaml` });

    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const row = store.claimNextQueued(`worker-${i}`);
      assert.ok(row);
      assert.equal(seen.has(row.id), false);
      seen.add(row.id);
    }
    assert.equal(seen.size, 5);
    assert.equal(store.claimNextQueued("worker-x"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run queue: finishQueued sets terminal fields for both completed and failed outcomes", () => {
  const { store, dir } = freshStore();
  try {
    store.enqueueRun({ id: "q-1", flowId: "flows/a.yaml" });
    store.enqueueRun({ id: "q-2", flowId: "flows/b.yaml" });
    store.claimNextQueued("worker-1");
    store.claimNextQueued("worker-1");

    store.finishQueued("q-1", { status: "completed", runId: "run_abc" });
    store.finishQueued("q-2", { status: "failed", error: "boom" });

    const rows = store.listQueue();
    const q1 = rows.find((r) => r.id === "q-1");
    const q2 = rows.find((r) => r.id === "q-2");
    assert.equal(q1?.status, "completed");
    assert.equal(q1?.runId, "run_abc");
    assert.ok(q1?.finishedAt);
    assert.equal(q2?.status, "failed");
    assert.equal(q2?.error, "boom");
    assert.ok(q2?.finishedAt);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run queue: listQueue filters by status and orders newest-enqueued first", () => {
  const { store, dir } = freshStore();
  try {
    store.enqueueRun({ id: "q-1", flowId: "flows/a.yaml" });
    store.enqueueRun({ id: "q-2", flowId: "flows/b.yaml" });
    store.enqueueRun({ id: "q-3", flowId: "flows/c.yaml" });
    store.claimNextQueued("worker-1"); // claims q-1 (oldest) -> running

    const all = store.listQueue();
    assert.deepEqual(all.map((r) => r.id), ["q-3", "q-2", "q-1"]); // newest enqueued first

    const queued = store.listQueue({ status: "queued" }).map((r) => r.id);
    assert.deepEqual(queued, ["q-3", "q-2"]);

    const running = store.listQueue({ status: "running" }).map((r) => r.id);
    assert.deepEqual(running, ["q-1"]);

    assert.equal(store.listQueue({ limit: 1 }).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser_sessions: pid persists through createBrowserSession + getBrowserSession", () => {
  const { store, dir } = freshStore();
  try {
    store.createBrowserSession({
      id: "bsess-pid-1",
      tenant: "tenant-x",
      startedAt: "2026-07-08T10:00:00.000Z",
      pid: 12345,
    });
    let got = store.getBrowserSession("bsess-pid-1");
    assert.equal(got?.pid, 12345);

    store.createBrowserSession({
      id: "bsess-no-pid",
      tenant: "tenant-x",
      startedAt: "2026-07-08T10:00:00.000Z",
    });
    assert.equal(store.getBrowserSession("bsess-no-pid")?.pid, undefined);

    store.setBrowserSessionPid("bsess-no-pid", 999);
    got = store.getBrowserSession("bsess-no-pid");
    assert.equal(got?.pid, 999);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("members: createMember then listMembers is newest-first and never exposes a token hash", () => {
  const { store, dir } = freshStore();
  try {
    store.createMember({ id: "mem-1", name: "Alice", role: "admin", tokenHash: hashMemberToken("raw-token-1") });
    store.createMember({ id: "mem-2", name: "Bob", role: "viewer", tokenHash: hashMemberToken("raw-token-2") });

    const members = store.listMembers();
    assert.deepEqual(members.map((m) => m.id), ["mem-2", "mem-1"]); // newest first

    const bob = members[0]!;
    assert.equal(bob.name, "Bob");
    assert.equal(bob.role, "viewer");
    assert.equal(bob.disabled, false);
    assert.ok(bob.createdAt);
    assert.equal(bob.lastLoginAt, undefined);

    // no member ever carries a token/tokenHash field, in any casing.
    for (const m of members) {
      assert.equal(Object.prototype.hasOwnProperty.call(m, "tokenHash"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(m, "token_hash"), false);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("members: findMemberByTokenHash round-trips a raw token via hashMemberToken", () => {
  const { store, dir } = freshStore();
  try {
    const rawToken = "pk_test-raw-token-abc123";
    store.createMember({ id: "mem-3", name: "Carol", role: "operator", tokenHash: hashMemberToken(rawToken) });

    const found = store.findMemberByTokenHash(hashMemberToken(rawToken));
    assert.ok(found);
    assert.equal(found.id, "mem-3");
    assert.equal(found.name, "Carol");
    assert.equal(found.role, "operator");
    assert.equal(found.disabled, false);

    assert.equal(store.findMemberByTokenHash(hashMemberToken("some-other-token")), undefined);
    assert.equal(store.findMemberByTokenHash("not-a-real-hash"), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("members: createMember throws a clear error on a duplicate token hash", () => {
  const { store, dir } = freshStore();
  try {
    const tokenHash = hashMemberToken("shared-raw-token");
    store.createMember({ id: "mem-4", name: "Dave", role: "viewer", tokenHash });

    assert.throws(() => store.createMember({ id: "mem-5", name: "Eve", role: "viewer", tokenHash }), /token/i);

    // the rejected insert left no partial row behind.
    assert.equal(store.listMembers().length, 1);
    assert.equal(store.listMembers()[0]?.id, "mem-4");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("members: setMemberDisabled flips state; findMemberByTokenHash still returns disabled rows", () => {
  const { store, dir } = freshStore();
  try {
    const tokenHash = hashMemberToken("token-for-disable-test");
    store.createMember({ id: "mem-6", name: "Frank", role: "operator", tokenHash });

    store.setMemberDisabled("mem-6", true);
    const found = store.findMemberByTokenHash(tokenHash);
    assert.ok(found); // disabled rows are still returned — caller decides
    assert.equal(found.disabled, true);
    assert.equal(store.listMembers().find((m) => m.id === "mem-6")?.disabled, true);

    store.setMemberDisabled("mem-6", false);
    assert.equal(store.findMemberByTokenHash(tokenHash)?.disabled, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("members: countMembers excludes disabled members by default", () => {
  const { store, dir } = freshStore();
  try {
    store.createMember({ id: "mem-7", name: "Gina", role: "viewer", tokenHash: hashMemberToken("t7") });
    store.createMember({ id: "mem-8", name: "Hank", role: "viewer", tokenHash: hashMemberToken("t8") });
    store.createMember({ id: "mem-9", name: "Ivy", role: "viewer", tokenHash: hashMemberToken("t9") });
    store.setMemberDisabled("mem-9", true);

    assert.equal(store.countMembers(), 2);
    assert.equal(store.countMembers(false), 2);
    assert.equal(store.countMembers(true), 3);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("members: touchMemberLogin sets last_login_at; unknown id is a no-op", () => {
  const { store, dir } = freshStore();
  try {
    store.createMember({ id: "mem-10", name: "Jill", role: "admin", tokenHash: hashMemberToken("t10") });
    assert.equal(store.listMembers()[0]?.lastLoginAt, undefined);

    store.touchMemberLogin("mem-10");
    const got = store.listMembers().find((m) => m.id === "mem-10");
    assert.ok(got?.lastLoginAt);

    store.touchMemberLogin("missing-member"); // no-op, must not throw
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
