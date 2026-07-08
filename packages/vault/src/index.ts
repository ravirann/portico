/**
 * @portico/vault — secret resolution, redaction, and TOTP.
 *
 * Secrets are resolved at run time and injected into the engine's AuthContext;
 * they are NEVER persisted in run state and MUST be redacted from every trace,
 * screenshot, rrweb capture, and log (docs/ARCHITECTURE.md §6).
 *
 * Pilot ships an env-var provider. Vault/Infisical/KMS providers implement the
 * same interface with envelope encryption.
 */

import { authenticator } from "otplib";

export interface SecretProvider {
  /** Resolve a secret by reference, e.g. "example/password". */
  get(ref: string): Promise<string>;
}

/** Reads secrets from environment variables. Ref "a/b" → env `PORTICO_SECRET_A_B`. */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async get(ref: string): Promise<string> {
    const key = "PORTICO_SECRET_" + ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    const value = this.env[key];
    if (value == null || value === "") {
      throw new Error(`Secret '${ref}' not found (expected env ${key}).`);
    }
    return value;
  }
}

/** Resolve a set of references into an injectable secrets map. */
export async function resolveSecrets(
  provider: SecretProvider,
  refs: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, ref] of Object.entries(refs)) out[name] = await provider.get(ref);
  return out;
}

/**
 * Redact every secret value from a string (traces, logs, extracted text).
 * Call on anything that could contain a secret before it leaves the run.
 */
export function redact(text: string, secretValues: Iterable<string>): string {
  let out = text;
  for (const secret of secretValues) {
    if (!secret) continue;
    out = out.split(secret).join("«redacted»");
  }
  return out;
}

/**
 * Generate a TOTP code from a vaulted seed, in-process, so the 2FA seed never
 * leaves the sandbox. Accepts a base32 authenticator secret (as shown by
 * "can't scan the code?" during authenticator-app setup).
 */
export function generateTotp(seed: string): string {
  const clean = seed.replace(/\s+/g, "").toUpperCase();
  if (!clean) throw new Error("generateTotp: empty TOTP seed");
  return authenticator.generate(clean);
}
