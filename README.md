# Portico

**Open-source, self-hostable platform for reliable, deterministic browser
automation of authenticated portals** — built for regulated domains (healthcare
payer/EHR) where the automation must run in your own VPC and PHI never leaves.

> Deterministic-first, AI-assisted. The LLM authors and heals; it is **never on
> the hot path of a promoted flow**. A healthy run's latency is *browser speed*,
> not *model speed*. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Why

Browser-automation tools are typically a *library* or a *managed cloud*. The
production platform around them — control plane, secret vault, durable/resumable
runs, audit, replay, self-host — is left to each team to build. Portico is that
platform, and it **composes an existing engine** ([Libretto](https://github.com/saffron-health/libretto),
behind a swappable adapter) rather than reinventing one.

## Repo layout

```
packages/
  flow-spec/   # the declarative flow contract (types)
  engine/      # EngineAdapter interface + Libretto adapter (+ fallback)
  vault/       # secret resolution, redaction, TOTP
connectors/
  example-portal/  # template connector: scheduling (discovery only, never commits)
docs/
  ARCHITECTURE.md          # founding doc + latency SLO
  decisions/0001-execution-engine.md   # engine decision (Libretto)
```

## Status — Phase 0 (engine)

Scaffolded. What's real vs. what's a wired-later seam:

| Piece | State |
|---|---|
| Flow spec contract (`@portico/flow-spec`) | ✅ types |
| Engine boundary (`EngineAdapter`) + registry | ✅ interface |
| Vault (env provider, redaction) | ✅ + tests |
| `example-portal` connector + flow YAMLs | ✅ specs |
| Engine adapter (Libretto, in-process) + `portico` CLI | ✅ **runs live** (`examples/smoke.flow.yaml` proven end-to-end) |
| ADR-0001 validation (in-process embeddable) | ✅ confirmed — `launchBrowser`/`attemptWithRecovery`/`extractFromPage` used directly |
| Portal auth + real selectors | pending the one-time record-by-demo (your login/2FA) |
| TOTP (`generateTotp`) | seam — wire `otplib` in the auth build |

### Prove it live (no credentials needed)

```bash
pnpm install
npx playwright install chromium
node --import tsx apps/cli/src/index.ts run examples/smoke.flow.yaml \
  --base-url https://example.com --headless
# → COMPLETED, output: { "page_title": "Example Domain" }
```

## Dev

```bash
pnpm install
pnpm test          # runs package tests (e.g. vault)
pnpm typecheck
```

## The two things to validate before wiring Libretto (ADR-0001)

1. **Telemetry off + self-host** for PHI (`LIBRETTO_CLOUD_*`).
2. **Invocation shape** — in-process (preferred) vs CLI/subprocess.

## License

Apache-2.0 (core). Commercial/cloud features (hosted control plane, SSO, managed
secrets, SLA) come later as an open-core layer.
