/**
 * Signed, stateless session cookie for the console's DB-backed member login
 * (see docs/DEPLOY.md, "Members & access control"). This module is PURE and
 * edge-safe — Web Crypto only (`globalThis.crypto.subtle`, `atob`/`btoa`,
 * `TextEncoder`/`TextDecoder`), zero Node-only imports — because it has to
 * run inside Next's Edge middleware (middleware.ts), not just Node-runtime
 * API routes. Node >= 20 (this repo's engines.node) ships `crypto.subtle`
 * globally, so the same code path works unmodified under
 * `node --import tsx --test` too (see session.test.ts).
 *
 * Cookie value shape: base64url(JSON payload) + "." + base64url(HMAC-SHA256
 * of the payload's base64url string, keyed by the shared secret). This is a
 * deliberately small, home-grown analogue of a JWS compact serialization —
 * self-contained (verifying needs only the secret, no DB round trip or
 * server-side session store), integrity-protected (any change to the
 * payload invalidates the signature), but NOT encrypted: the payload is
 * plainly readable by base64url-decoding it, same as a JWT. Don't put
 * anything in `SessionPayload` that shouldn't be readable by whoever holds
 * the cookie (which is only ever the browser it was issued to, over an
 * httpOnly cookie — see app/api/auth/login/route.ts).
 *
 * Revocation is NOT immediate: a member disabled via `member-disable` (or an
 * env token removed from PORTICO_RBAC_TOKENS) stops working on their NEXT
 * login attempt, but an already-signed-in session stays valid — this module
 * only checks the signature and `exp`, never the DB — until it hits `exp`.
 * Worst-case revocation lag therefore equals the session TTL (see
 * PORTICO_SESSION_TTL_HOURS in docs/DEPLOY.md).
 */

export interface SessionPayload {
  /** Member id (`mem_xxxxxxxx`, see packages/store/src/store.ts createMember)
   *  for a DB-backed login, or a synthetic `env:<role>:<name>` id for a
   *  session minted from an env static token (see app/api/auth/login's
   *  resolution order) — there is no member row to point at in that case. */
  id: string;
  name: string;
  role: "viewer" | "operator" | "admin";
  /** Unix seconds (NOT milliseconds) — issued-at. */
  iat: number;
  /** Unix seconds — expiry. `verifySession` rejects once `now >= exp`. */
  exp: number;
}

/** Cookie name shared by middleware.ts, the login/logout routes, and any
 *  future reader — defined once here so it can't drift between call sites. */
export const SESSION_COOKIE_NAME = "portico_session";

function isRole(value: unknown): value is SessionPayload["role"] {
  return value === "viewer" || value === "operator" || value === "admin";
}

/** Structural validation for a decoded JSON payload — cheap insurance in
 *  case the secret was ever reused for something else, or a future bug
 *  produces a validly-signed-but-wrong-shaped payload. A tampered payload is
 *  already caught by the signature check in `verifySession` before this
 *  ever runs; this is a second, independent guard. */
function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    isRole(v.role) &&
    typeof v.iat === "number" &&
    typeof v.exp === "number"
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  // btoa only ever sees Latin1 byte values here (each `b` is 0-255), so it
  // never throws — the usual btoa("non-Latin1 string") failure mode doesn't
  // apply to a manually-built byte-per-char binary string like this one.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  // Explicit ArrayBuffer backing so the result satisfies BufferSource under
  // TS 5.9's stricter Uint8Array<ArrayBufferLike> vs ArrayBuffer split.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function encodeJsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * Sign a session payload into a `portico_session` cookie value. Pure
 * encode-then-sign — it does not read the clock or apply any TTL itself;
 * the caller (app/api/auth/login/route.ts) is responsible for computing
 * `iat`/`exp` (from PORTICO_SESSION_TTL_HOURS) before calling this, which
 * also makes both this function and its tests trivially deterministic.
 */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const payloadB64 = encodeJsonToBase64Url(payload);
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = bytesToBase64Url(new Uint8Array(signature));
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a `portico_session` cookie value against `secret`. Returns the
 * decoded payload on success, or `null` for ANY failure — a bad/missing
 * signature, a malformed cookie value, a structurally-wrong payload, an
 * expired session, or a wrong secret. Never throws: every failure mode
 * (including a garbage cookie value that isn't valid base64/JSON at all)
 * funnels into the same `null` — callers (middleware.ts) treat `null`
 * exactly like "no session cookie presented".
 */
export async function verifySession(cookieValue: string, secret: string): Promise<SessionPayload | null> {
  try {
    const dot = cookieValue.indexOf(".");
    if (dot <= 0 || dot === cookieValue.length - 1) return null;
    const payloadB64 = cookieValue.slice(0, dot);
    const sigB64 = cookieValue.slice(dot + 1);

    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(sigB64),
      new TextEncoder().encode(payloadB64),
    );
    if (!valid) return null;

    const decoded: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadB64)));
    if (!isSessionPayload(decoded)) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (nowSeconds >= decoded.exp) return null;

    return decoded;
  } catch {
    // Malformed base64, invalid JSON, an empty string, etc. — all the same
    // "not a valid session" outcome as a bad signature.
    return null;
  }
}

/**
 * The secret sessions are signed with: PORTICO_AUTH_SECRET if set, else
 * PORTICO_ENCRYPTION_KEY (the same key that already encrypts session
 * storage_state at rest — see packages/store/src/crypto.ts) as a
 * convenience fallback so a self-hoster who already set one secret doesn't
 * have to configure a second, else `undefined` — callers (the login route)
 * treat `undefined` as "sign-in sessions aren't configured yet" and refuse
 * to mint a cookie rather than signing with an empty/guessable secret.
 */
export function sessionSecret(env: Record<string, string | undefined>): string | undefined {
  return env.PORTICO_AUTH_SECRET || env.PORTICO_ENCRYPTION_KEY || undefined;
}
