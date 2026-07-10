# Secrets

> Where a Portico credential can live, and how to keep it encrypted at rest.
> Applies whether you're running the CLI directly or the self-hosted
> container (docs/DEPLOY.md).

## The three layers

1. **`.env` (`PORTICO_SECRET_*`)** — the default. A flow/instance references
   a secret by ref, e.g. `urmc/username`; `EnvSecretProvider` maps `a/b` →
   env var `PORTICO_SECRET_A_B` and reads it from the process environment.
   See `.env.example`.
2. **`PORTICO_SECRETS_FILE`** (optional) — a flat JSON file of `ref -> value`,
   resolved *before* falling back to `.env`. Lets you keep credentials in one
   file whose at-rest encryption you control (age/SOPS, below), instead of
   plaintext env vars. Implemented by `FileSecretProvider` /
   `ChainSecretProvider` in `packages/vault/src/index.ts`.
3. **`app_config` (encrypted, `PORTICO_ENCRYPTION_KEY`)** — LLM keys and
   connector variables entered through the console's Settings UI live in the
   SQLite store's `app_config` table. Values flagged `secret: true` are
   encrypted with the same AES-256-GCM cipher used for session
   storage-state (`packages/store/src/crypto.ts`), keyed by
   `PORTICO_ENCRYPTION_KEY` — see the "Configure secrets" step in
   docs/DEPLOY.md. Leave that key unset and Portico still runs, falling back
   to base64 *encoding* (not encryption) with a loud warning in the logs —
   fine for kicking the tires, not for real credentials.

Layers 1–2 are how a flow/instance's secret *refs* get resolved at run time;
layer 3 is a separate system (console-entered settings) that happens to
share an encryption story. Don't confuse `PORTICO_SECRETS_FILE` (a file the
*operator* provisions before a run) with `app_config` (rows the *console UI*
writes at runtime).

## Using a secrets file

Point `PORTICO_SECRETS_FILE` at a flat JSON object mapping the same refs
your flows/instances use:

```json
{
  "urmc/username": "someone@example.com",
  "urmc/password": "hunter2",
  "urmc/totp_seed": "JBSWY3DPEHPK3PXP"
}
```

```bash
export PORTICO_SECRETS_FILE=/run/secrets/secrets.json
```

Resolution order is **file, then env**: `defaultSecretProvider()` — what the
CLI constructs its provider from — chains `FileSecretProvider` ahead of
`EnvSecretProvider`, so a ref present in the file wins, and anything the file
doesn't define falls through to `PORTICO_SECRET_*`. A missing or unset
`PORTICO_SECRETS_FILE` is not an error: the file provider just resolves
nothing and every ref falls through to `.env` — identical to today's
behavior if you never set the variable. A file that *exists* but isn't valid
JSON (or isn't a flat object) throws immediately at startup, with an error
naming the path and what was expected — a broken secrets file should fail
loudly, not silently resolve nothing.

## Encrypting the secrets file at rest

`PORTICO_SECRETS_FILE` itself is read as plaintext JSON — Portico does no
decryption of its own. Keep it encrypted on disk and decrypt it only into a
short-lived location right before Portico starts. Two common tools:

### With [age](https://github.com/FiloSottile/age)

```bash
# Once: generate a keypair. Keep key.txt private; the public key (printed to
# stdout, also embedded as a comment in key.txt) is safe to share/commit.
age-keygen -o key.txt
# Public key: age1qy...

# Encrypt your plaintext secrets file against that public key:
age -r age1qy... -o secrets.json.age secrets.json
# (commit/ship secrets.json.age; never commit secrets.json or key.txt)

# At start, decrypt to a tmpfs mount (never touches a persistent disk):
mkdir -p /run/secrets
mount -t tmpfs -o size=1m,mode=0700 tmpfs /run/secrets   # once, e.g. in your entrypoint
age -d -i key.txt -o /run/secrets/secrets.json secrets.json.age
export PORTICO_SECRETS_FILE=/run/secrets/secrets.json

# Or skip the intermediate file with process substitution (bash/zsh):
export PORTICO_SECRETS_FILE=<(age -d -i key.txt secrets.json.age)
```

### With [SOPS](https://github.com/getsops/sops)

```bash
# Once: an age key works fine as the SOPS backend too (KMS/PGP also supported).
age-keygen -o key.txt

# Encrypt (SOPS keeps keys visible/greppable, encrypts only values):
sops --encrypt --age age1qy... secrets.json > secrets.enc.json

# At start, decrypt to tmpfs:
SOPS_AGE_KEY_FILE=key.txt sops --decrypt secrets.enc.json > /run/secrets/secrets.json
export PORTICO_SECRETS_FILE=/run/secrets/secrets.json

# Or pipe straight in via process substitution, no plaintext file at all:
export PORTICO_SECRETS_FILE=<(SOPS_AGE_KEY_FILE=key.txt sops --decrypt secrets.enc.json)
```

Either way, the pattern is the same: ciphertext is what's committed/shipped;
the decrypt step runs once, right before Portico starts, into a tmpfs path or
a process-substitution fifo; `PORTICO_SECRETS_FILE` only ever points at
plaintext that disappears when the process/container exits. If you're
running the Docker Compose self-host (docs/DEPLOY.md), do the decrypt step in
your own entrypoint wrapper before `docker compose up` execs the app, and
bind-mount the resulting tmpfs path in.

## The redaction guarantee

Whatever provider resolves a secret's value — env, file, or chained — it
flows into the engine's auth secrets map the same way, and from there
`redact()` (`packages/vault/src/index.ts`) is what keeps it out of anything
the run produces:

- The engine collects every resolved secret value (`Object.values(auth.secrets)`)
  once per run and uses `redact(text, secretValues)` to scrub step trace
  `detail` fields and failure `reason` strings before they're recorded
  (`packages/engine/src/runner.ts`).
- The rrweb session capture is passed through the same `redact()` before
  it's written to disk, so a resolved secret can't land in that artifact
  either (`packages/engine/src/recording.ts`).
- `redact()` itself is a plain substring replace: every non-empty secret
  value in the text is swapped for the literal `«redacted»`. It doesn't know
  or care which provider produced the value — a `FileSecretProvider` or
  `ChainSecretProvider` secret is redacted exactly as an `EnvSecretProvider`
  one is, with no extra wiring needed.

This is the mechanism behind the "redaction by construction" guarantee in
docs/ARCHITECTURE.md §6: flagged secret values are masked in DOM traces,
rrweb replays, and logs, regardless of which layer above resolved them.
