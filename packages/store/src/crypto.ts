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
