import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvSecretProvider, redact, resolveSecrets } from "./index.js";

test("EnvSecretProvider resolves refs from env and errors when missing", async () => {
  const p = new EnvSecretProvider({ PORTICO_SECRET_EXAMPLE_PASSWORD: "hunter2" });
  assert.equal(await p.get("example/password"), "hunter2");
  await assert.rejects(() => p.get("example/missing"), /not found/);
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
