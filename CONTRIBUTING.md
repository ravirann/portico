# Contributing to Portico

Thanks for helping build the open-source platform for reliable, deterministic
browser automation. Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
the design and principles, and [docs/decisions/](docs/decisions/) for the "why"
behind key choices.

## Connectors are the extension surface

**The primary way to contribute is a connector.** A connector is a target site +
its flows + auth — the unit that makes Portico automate a new portal. This is the
OSS flywheel: the platform ships the engine and tooling; the community ships
connectors.

A connector lives under `connectors/<name>/`:

```
connectors/<name>/
  target.yaml               # framework, base_url, allowed_domains (egress), auth
  flows/*.flow.yaml         # the deterministic step graphs
  instances/*.yaml          # per-org overrides (base_url, secret refs, 2FA type)
  README.md
```

See `connectors/example-portal/` as the reference. Because connectors declare a
`framework` (e.g. `example-portal`), a self-heal on one instance strengthens the
connector for every org on that framework.

**Connector guidelines**
- Flows must respect the invariants: **no LLM on a promoted hot path**
  (authoring/heal only), guards for any write (`no_booking`, `dry_run_only`,
  `forbidden_actions`), and a hard egress boundary via `allowed_domains`.
- Never commit secrets or session state. Use secret *references*
  (resolved by `@portico/vault`); real values live in env/secret store.
- Automate only portals you (or your users) are authorized to access.

## Development

```bash
pnpm install
pnpm test         # package tests (node:test)
pnpm typecheck
```

- **Language:** TypeScript, ESM, strict mode.
- **Boundaries:** the platform depends only on the `EngineAdapter` interface
  (`packages/engine`); engine specifics stay behind adapters.
- Keep changes additive and covered by a test where there's runtime behavior.

## Pull requests

- One focused change per PR; describe the "why".
- Link an ADR (or add one under `docs/decisions/`) for architectural decisions.
- Ensure `pnpm test` and `pnpm typecheck` pass.

## Security & compliance

Portico targets regulated domains (healthcare). Never log, screenshot, or
persist secrets or PHI; redaction is enforced by construction (`@portico/vault`).
Report security issues privately rather than in a public issue.
