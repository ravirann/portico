import assert from "node:assert/strict";
import { test } from "node:test";
import { aesGcmCipher, base64Cipher } from "./crypto.js";

test("aes-gcm round-trips and produces confidential (non-plaintext, non-base64) ciphertext", () => {
  const c = aesGcmCipher("a-strong-encryption-key-1234567890");
  const secret = "sk-ant-super-secret-key";
  const enc = c.encrypt(secret);
  assert.ok(enc.startsWith("g1:"), "versioned prefix");
  assert.notEqual(enc, secret);
  // must NOT be trivially reversible base64 (the old weakness)
  assert.notEqual(Buffer.from(enc.slice(3), "base64").toString("utf8"), secret);
  assert.equal(c.decrypt(enc), secret);
});

test("aes-gcm uses a fresh IV per encrypt (same plaintext → different ciphertext)", () => {
  const c = aesGcmCipher("key-material-key-material-key-1234");
  assert.notEqual(c.encrypt("same"), c.encrypt("same"));
});

test("aes-gcm detects tampering (auth tag)", () => {
  const c = aesGcmCipher("key-material-key-material-key-1234");
  const enc = c.encrypt("integrity-protected");
  const raw = Buffer.from(enc.slice(3), "base64");
  raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
  const tampered = "g1:" + raw.toString("base64");
  assert.throws(() => c.decrypt(tampered));
});

test("aes-gcm decrypts legacy base64 values (no prefix) for migration", () => {
  const c = aesGcmCipher("key-material-key-material-key-1234");
  const legacy = base64Cipher.encrypt("written-before-encryption");
  assert.equal(c.decrypt(legacy), "written-before-encryption");
});

test("a wrong key cannot decrypt", () => {
  const enc = aesGcmCipher("the-right-key-the-right-key-12345").encrypt("secret");
  assert.throws(() => aesGcmCipher("a-different-key-a-different-key-9").decrypt(enc));
});
