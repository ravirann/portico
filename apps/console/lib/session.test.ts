/**
 * Pure-logic tests for the console's session cookie (apps/console/lib/session.ts).
 * No Next.js runtime involved — run directly:
 *   node --import tsx --test apps/console/lib/session.test.ts
 * Relies on globalThis.crypto.subtle (Node >= 20, see this repo's engines.node).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSecret, signSession, verifySession, type SessionPayload } from "./session.js";

const SECRET = "test-secret-please-ignore";

function makePayload(overrides: Partial<SessionPayload> = {}): SessionPayload {
  const iat = Math.floor(Date.now() / 1000);
  return { id: "mem_abc123", name: "ravi", role: "operator", iat, exp: iat + 3600, ...overrides };
}

test("round-trip: signSession then verifySession returns the same payload", async () => {
  const payload = makePayload();
  const cookie = await signSession(payload, SECRET);
  const result = await verifySession(cookie, SECRET);
  assert.deepEqual(result, payload);
});

test("tampered payload is rejected: modifying the payload segment invalidates the signature", async () => {
  const payload = makePayload({ role: "viewer" });
  const cookie = await signSession(payload, SECRET);
  const [payloadB64, sigB64] = cookie.split(".");

  // Decode, escalate the role, re-encode — but keep the ORIGINAL signature,
  // exactly like an attacker who can read/edit the (unencrypted) payload but
  // doesn't know the secret.
  const decoded = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  decoded.role = "admin";
  const tamperedB64 = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
  const tamperedCookie = `${tamperedB64}.${sigB64}`;

  assert.equal(await verifySession(tamperedCookie, SECRET), null);
});

test("wrong secret is rejected", async () => {
  const cookie = await signSession(makePayload(), SECRET);
  assert.equal(await verifySession(cookie, "a-completely-different-secret"), null);
});

test("expired session is rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = makePayload({ iat: now - 7200, exp: now - 3600 }); // expired an hour ago
  const cookie = await signSession(payload, SECRET);
  assert.equal(await verifySession(cookie, SECRET), null);
});

test("a session expiring exactly now is rejected (exp is exclusive)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const payload = makePayload({ iat: now - 60, exp: now });
  const cookie = await signSession(payload, SECRET);
  assert.equal(await verifySession(cookie, SECRET), null);
});

test("malformed cookie values are rejected without throwing", async () => {
  for (const bad of ["", "no-dot-at-all", ".", "abc.", ".xyz", "not base64!!.also not base64!!"]) {
    assert.equal(await verifySession(bad, SECRET), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("a validly-signed but structurally wrong payload is rejected", async () => {
  // Sign some arbitrary JSON that isn't shaped like a SessionPayload at all —
  // verifySession must reject it even though the signature is genuinely
  // valid for that (wrong-shaped) payload.
  const cookie = await signSession({ hello: "world" } as unknown as SessionPayload, SECRET);
  assert.equal(await verifySession(cookie, SECRET), null);
});

test("sessionSecret prefers PORTICO_AUTH_SECRET over PORTICO_ENCRYPTION_KEY", () => {
  assert.equal(
    sessionSecret({ PORTICO_AUTH_SECRET: "auth-secret", PORTICO_ENCRYPTION_KEY: "enc-key" }),
    "auth-secret",
  );
});

test("sessionSecret falls back to PORTICO_ENCRYPTION_KEY when PORTICO_AUTH_SECRET is unset", () => {
  assert.equal(sessionSecret({ PORTICO_ENCRYPTION_KEY: "enc-key" }), "enc-key");
});

test("sessionSecret is undefined when neither env var is set", () => {
  assert.equal(sessionSecret({}), undefined);
  assert.equal(sessionSecret({ PORTICO_AUTH_SECRET: "", PORTICO_ENCRYPTION_KEY: "" }), undefined);
});
