/**
 * @portico/vault — secret resolution, redaction, and TOTP.
 *
 * Secrets are resolved at run time and injected into the engine's AuthContext;
 * they are NEVER persisted in run state and MUST be redacted from every trace,
 * screenshot, rrweb capture, and log (docs/ARCHITECTURE.md §6).
 *
 * Pilot ships an env-var provider and a file-based provider (chainable via
 * ChainSecretProvider — see defaultSecretProvider), so a secrets file can be
 * kept encrypted at rest and decrypted just-in-time; see docs/SECRETS.md.
 * Vault/Infisical/KMS providers implement the same interface with envelope
 * encryption.
 */

import { readFileSync } from "node:fs";

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
    return value ?? "";
  }
}

/**
 * Reads secrets from a flat JSON file: `{"a/b": "value", ...}`. Path defaults
 * to `PORTICO_SECRETS_FILE`, so it's opt-in — leave it unset and this behaves
 * like an empty provider. Meant for mounting a secret set decrypted just-in-time
 * (age/SOPS at container start; see docs/SECRETS.md) instead of plaintext env vars.
 *
 * A missing/unset path is NOT an error — construction never throws for that
 * case, `get()` just resolves nothing — so `new FileSecretProvider()` is
 * always safe to construct and chain ahead of EnvSecretProvider (see
 * ChainSecretProvider / defaultSecretProvider) whether or not an operator has
 * opted into a secrets file. A *malformed* file (bad JSON, or valid JSON
 * that isn't a flat object) DOES throw at construction: that means an
 * operator pointed at a real file that's broken, which should fail loudly
 * at startup rather than silently resolve nothing.
 */
export class FileSecretProvider implements SecretProvider {
  private readonly secrets: Record<string, string>;

  constructor(path: string | undefined = process.env.PORTICO_SECRETS_FILE) {
    let raw: string | undefined;
    if (path) {
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        raw = undefined; // missing file, bad permissions, etc. — treat as absent, not an error
      }
    }
    if (raw === undefined) {
      this.secrets = {};
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `FileSecretProvider: ${path} is not valid JSON (${reason}). ` +
          `Expected a flat object mapping ref -> value, e.g. {"urmc/username": "..."}.`,
      );
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `FileSecretProvider: ${path} must contain a flat JSON object mapping ref -> value, ` +
          `e.g. {"urmc/username": "..."} (got ${Array.isArray(parsed) ? "an array" : typeof parsed}).`,
      );
    }
    this.secrets = parsed as Record<string, string>;
  }

  async get(ref: string): Promise<string> {
    const value = this.secrets[ref];
    return typeof value === "string" ? value : "";
  }
}

/**
 * Tries each provider in order and returns the first non-empty result,
 * falling through on "" — consistent with this file's convention (see
 * EnvSecretProvider above) that an absent secret resolves to "" rather than
 * undefined. Typical use is letting a secrets file override env:
 * `new ChainSecretProvider([new FileSecretProvider(), new EnvSecretProvider()])`.
 */
export class ChainSecretProvider implements SecretProvider {
  constructor(private readonly providers: readonly SecretProvider[]) {}

  async get(ref: string): Promise<string> {
    for (const provider of this.providers) {
      const value = await provider.get(ref);
      if (value) return value;
    }
    return "";
  }
}

/**
 * Default provider wiring for call sites: a FileSecretProvider chained ahead
 * of EnvSecretProvider when `PORTICO_SECRETS_FILE` is set (file wins on a ref
 * both define), otherwise exactly `new EnvSecretProvider()` — so leaving
 * PORTICO_SECRETS_FILE unset is a strict no-op versus constructing
 * EnvSecretProvider directly today.
 */
export function defaultSecretProvider(env: Record<string, string | undefined> = process.env): SecretProvider {
  if (!env.PORTICO_SECRETS_FILE) return new EnvSecretProvider(env);
  return new ChainSecretProvider([new FileSecretProvider(env.PORTICO_SECRETS_FILE), new EnvSecretProvider(env)]);
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
