import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChainSecretProvider,
  EnvSecretProvider,
  FileSecretProvider,
  defaultSecretProvider,
  redact,
  resolveSecrets,
} from "./index.js";

/** Writes `contents` to a fresh temp dir; caller must rmSync(dir) when done. */
function freshSecretsFile(contents: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "portico-vault-"));
  const path = join(dir, "secrets.json");
  writeFileSync(path, contents, "utf8");
  return { path, dir };
}

test("EnvSecretProvider resolves refs from env; missing → empty string", async () => {
  const p = new EnvSecretProvider({ PORTICO_SECRET_EXAMPLE_PASSWORD: "hunter2" });
  assert.equal(await p.get("example/password"), "hunter2");
  // Missing secrets resolve to "" so optional creds (e.g. totp_seed) don't throw.
  assert.equal(await p.get("example/missing"), "");
});

test("resolveSecrets maps a set of references", async () => {
  const p = new EnvSecretProvider({
    PORTICO_SECRET_EXAMPLE_USER: "alice",
    PORTICO_SECRET_EXAMPLE_PASSWORD: "hunter2",
  });
  const secrets = await resolveSecrets(p, { username: "example/user", password: "example/password" });
  assert.deepEqual(secrets, { username: "alice", password: "hunter2" });
});

test("redact removes every secret value from text", () => {
  const out = redact("login as alice with hunter2 token abc", ["hunter2", "alice"]);
  assert.equal(out, "login as «redacted» with «redacted» token abc");
  assert.doesNotMatch(out, /hunter2|alice/);
});

test("redact tolerates empty secrets", () => {
  assert.equal(redact("nothing secret", ["", "absent"]), "nothing secret");
});

test("FileSecretProvider resolves refs from its JSON file", async () => {
  const { path, dir } = freshSecretsFile(JSON.stringify({ "urmc/username": "alice", "urmc/password": "hunter2" }));
  try {
    const p = new FileSecretProvider(path);
    assert.equal(await p.get("urmc/username"), "alice");
    assert.equal(await p.get("urmc/password"), "hunter2");
    // Same "" -for-absent convention as EnvSecretProvider.
    assert.equal(await p.get("urmc/missing"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileSecretProvider resolves nothing when the file is missing, without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "portico-vault-"));
  try {
    assert.doesNotThrow(() => new FileSecretProvider(join(dir, "does-not-exist.json")));
    const p = new FileSecretProvider(join(dir, "does-not-exist.json"));
    assert.equal(await p.get("urmc/username"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileSecretProvider throws an actionable error on malformed JSON", () => {
  const { path, dir } = freshSecretsFile("{ not valid json");
  try {
    assert.throws(() => new FileSecretProvider(path), /is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileSecretProvider throws when the JSON isn't a flat object", () => {
  const { path, dir } = freshSecretsFile(JSON.stringify(["a", "b"]));
  try {
    assert.throws(() => new FileSecretProvider(path), /flat.*object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChainSecretProvider: first provider with a non-empty value wins (file overrides env)", async () => {
  const { path, dir } = freshSecretsFile(JSON.stringify({ "urmc/username": "from-file" }));
  try {
    const chain = new ChainSecretProvider([
      new FileSecretProvider(path),
      new EnvSecretProvider({
        PORTICO_SECRET_URMC_USERNAME: "from-env",
        PORTICO_SECRET_URMC_PASSWORD: "from-env-only",
      }),
    ]);
    // File has urmc/username, so it wins over env's value for the same ref.
    assert.equal(await chain.get("urmc/username"), "from-file");
    // File doesn't have urmc/password, so env is used.
    assert.equal(await chain.get("urmc/password"), "from-env-only");
    // Neither provider has this ref.
    assert.equal(await chain.get("urmc/missing"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultSecretProvider without PORTICO_SECRETS_FILE behaves exactly like EnvSecretProvider", async () => {
  const env = { PORTICO_SECRET_URMC_USERNAME: "alice" }; // no PORTICO_SECRETS_FILE
  const provider = defaultSecretProvider(env);
  assert.ok(provider instanceof EnvSecretProvider);
  assert.equal(await provider.get("urmc/username"), "alice");
  assert.equal(await provider.get("urmc/missing"), "");
});

test("defaultSecretProvider with PORTICO_SECRETS_FILE set chains file ahead of env", async () => {
  const { path, dir } = freshSecretsFile(JSON.stringify({ "urmc/username": "from-file" }));
  try {
    const env = { PORTICO_SECRETS_FILE: path, PORTICO_SECRET_URMC_USERNAME: "from-env" };
    const provider = defaultSecretProvider(env);
    assert.equal(await provider.get("urmc/username"), "from-file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
