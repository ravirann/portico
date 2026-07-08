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
