/**
 * Session-encryption seam.
 *
 * `storage_state` (cookies + local/session storage that lets a run skip
 * login/2FA) is sensitive and MUST never be logged. It is written through a
 * pluggable `SessionCipher` so the at-rest representation can be upgraded
 * without touching the repository.
 *
 * Pilot ships a base64 codec — this is ENCODING, NOT ENCRYPTION.
 *
 * TODO(security): replace `base64Cipher` with envelope encryption backed by a
 * KMS (AES-256-GCM data key wrapped by a KMS CMK). The `SessionCipher`
 * interface is the seam; no repository code changes when this lands.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

export interface SessionCipher {
  /** Encrypt/encode plaintext storage state into an at-rest string. */
  encrypt(plaintext: string): string;
  /** Reverse of `encrypt`. */
  decrypt(ciphertext: string): string;
}

/** Base64 codec. Placeholder only — provides no confidentiality. */
export const base64Cipher: SessionCipher = {
  encrypt(plaintext: string): string {
    return Buffer.from(plaintext, "utf8").toString("base64");
  },
  decrypt(ciphertext: string): string {
    return Buffer.from(ciphertext, "base64").toString("utf8");
  },
};

const GCM_PREFIX = "g1:"; // versioned tag so we can migrate/rotate later

/**
 * Real at-rest encryption: AES-256-GCM (authenticated). The 32-byte key is
 * derived from `secret` via SHA-256, a random 96-bit IV is used per value, and
 * the GCM auth tag is stored so tampering is detected on decrypt.
 *
 * Ciphertext format: "g1:" + base64(iv[12] ‖ tag[16] ‖ ciphertext). Values
 * written by the old base64 codec (no prefix) still decrypt, so this is a
 * drop-in upgrade — new writes are encrypted, legacy reads keep working.
 */
export function aesGcmCipher(secret: string): SessionCipher {
  const key = createHash("sha256").update(secret, "utf8").digest();
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return GCM_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
    },
    decrypt(ciphertext: string): string {
      if (!ciphertext.startsWith(GCM_PREFIX)) {
        // Legacy value written before encryption landed — decode as base64.
        return Buffer.from(ciphertext, "base64").toString("utf8");
      }
      const raw = Buffer.from(ciphertext.slice(GCM_PREFIX.length), "base64");
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const enc = raw.subarray(28);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
    },
  };
}

let warnedNoKey = false;

/**
 * The cipher the Store uses by default: AES-256-GCM when `PORTICO_ENCRYPTION_KEY`
 * is set, otherwise base64 with a one-time loud warning (dev still works, but
 * secrets are NOT confidential until a key is configured).
 */
export function defaultCipher(env: NodeJS.ProcessEnv = process.env): SessionCipher {
  const key = env.PORTICO_ENCRYPTION_KEY;
  if (key && key.length >= 16) return aesGcmCipher(key);
  if (!warnedNoKey) {
    warnedNoKey = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[store] PORTICO_ENCRYPTION_KEY not set (or < 16 chars) — secrets are base64-encoded, NOT encrypted. Set a strong key to encrypt at rest.",
    );
  }
  return base64Cipher;
}
