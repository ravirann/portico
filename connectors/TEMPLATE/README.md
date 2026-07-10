# Connector: TEMPLATE

A blank starting point for a new connector. Copy this whole directory, rename
it to your target portal's slug (e.g. `connectors/acme-portal/`), and fill in
the placeholders. For a fully worked example of the same layout — a real
scheduling flow, API-tier extraction, and guards — see `connectors/example-portal/`.

- `target.yaml` — the target manifest (framework, egress boundary, auth).
  Rename `key`, `name`, and `framework`, and keep `auth` pointed at your login
  flow's key.
- `flows/login.flow.yaml` — reusable 2FA-aware auth subflow, referenced by
  `auth:` in `target.yaml`. The locators and condition names in this template
  are generic placeholders — replace them with the ones from your own
  record-by-demonstration session.
- `instances/` — per-deployment overrides (base URL, host, secret references).
  Not included in this template; copy the shape from
  `connectors/example-portal/instances/example.yaml`. Keep real hosts and
  credentials out of git — use a gitignored `*.local.yaml` and resolve secrets
  through `@portico/vault` (env-backed) at run time.

Flows in this pack are executed by whichever `EngineAdapter` the platform is
configured with (see `docs/ADAPTER-SDK.md`) — building a connector never
requires touching engine code.

## Authoring (one-time, human)

Flow YAML is the *target contract*, not something you hand-write from a blank
page. Real locators come from a **record-by-demonstration** session (you log
in — 2FA is yours — and click to the target screen); the engine compiles the
deterministic steps and you review them before committing. See
`docs/ARCHITECTURE.md` §3 ("Authoring: demonstration → deterministic flow")
and `docs/decisions/0002-agent-authoring.md`.

## Next steps after copying this template

1. Rename the directory, then update `key` / `name` / `framework` in
   `target.yaml` (keep `auth` matching your login flow's `key`).
2. Record a login demonstration and replace the placeholder locators and
   condition names in `flows/login.flow.yaml`.
3. Add one flow per goal (e.g. a read/extract flow), using the step
   vocabulary in `packages/flow-spec/src/index.ts` (`navigate`, `act`,
   `extract`, `assert`, `guard`, `human`, `resolve`, `read`, `select`,
   `intercept`, `wait`, `subflow`, …) — follow `connectors/example-portal/flows/`
   for worked examples of each.
4. Add an `instances/<name>.yaml` (or a gitignored `*.local.yaml`) with the
   real `base_url`, `host`, and secret references for each deployment.
5. If a flow only reads data and must never commit/book/submit, set
   `guard: { no_booking: true, dry_run_only: true, forbidden_actions: [...] }`
   like `connectors/example-portal/flows/portal-schedule.flow.yaml` does.
