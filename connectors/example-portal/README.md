# Connector: example-portal

A template connector for automating an authenticated portal. Copy it to build a
real connector. Deployments of the same portal share a `framework`, so a
self-heal on one instance strengthens the connector for all of them.

- `target.yaml` — the target (framework, egress boundary, auth).
- `flows/portal-login.flow.yaml` — reusable 2FA-aware auth subflow (HITL once → persisted trusted session).
- `flows/portal-schedule.flow.yaml` — reach a selection screen and return options. **Never commits** (`guard.no_booking`).
- `flows/portal-livetest.flow.yaml` — headed manual-login smoke against a live portal.
- `instances/example.yaml` — example instance. Keep real deployments in a
  gitignored `*.local.yaml` and pass secrets via env (`@portico/vault`).

## Authoring (one-time, human)

Flow YAML is the *target contract*. Real locators come from a
**record-by-demonstration** session (you log in — 2FA is yours — and click to the
target screen); the engine compiles the deterministic steps and you review them.
See `docs/ARCHITECTURE.md` §5.

## Live test

```bash
node --import tsx apps/cli/src/index.ts run \
  connectors/example-portal/flows/portal-livetest.flow.yaml \
  --base-url https://your-portal.example.com
```

Pass your real portal URL at runtime — it is not stored in the repo.
