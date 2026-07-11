# Self-host with Docker Compose

> One container, one command, nothing external. The console and the engine
> (real Chromium, via Playwright) run together on your own machine; the only
> network calls a run makes are to the portal that flow targets, plus your
> chosen AI provider if you opt into self-heal or authoring. Credentials and
> run data never leave the host this is running on.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with the Compose plugin
  (Docker Desktop includes both; `docker compose version` should print
  something).

## Run it

```bash
# 1. Configure secrets. PORTICO_ENCRYPTION_KEY is what encrypts session
#    storage-state (cookies/local-storage that let a run skip login/2FA) at
#    rest — generate one and paste it in:
cp deploy/.env.example deploy/.env
openssl rand -base64 32   # paste the output as PORTICO_ENCRYPTION_KEY in deploy/.env

# 2. Build the image and start the container in the background. First run
#    builds from scratch (pulls the Playwright base image, installs the
#    workspace, builds the console) — a few minutes; after that it's cached.
docker compose -f deploy/docker-compose.yml up -d

# 3. Open the console:
open http://localhost:4400   # or just visit it in a browser
```

`PORTICO_ENCRYPTION_KEY` is the only thing you need to set to get real
encryption at rest. Leave it unset and Portico still runs — it falls back to
base64 *encoding* (not encryption) with a loud warning in the container logs,
which is fine for kicking the tires but not for anything touching real
credentials. The self-heal and authoring rows in `deploy/.env.example` are
optional — only needed if you want AI-assisted recovery/authoring, and off the
hot path of a promoted flow either way.

For flow/instance credentials (`PORTICO_SECRET_*`, plus the optional
`PORTICO_SECRETS_FILE` for keeping them encrypted at rest with age/SOPS), see
docs/SECRETS.md.

To follow logs: `docker compose -f deploy/docker-compose.yml logs -f`.
To stop: `docker compose -f deploy/docker-compose.yml down` (add `-v` only if
you also want to delete the persisted data volume, see below).

## Where your data lives

Everything Portico persists — the SQLite store (runs, steps, sessions, flows,
audit log) and run artifacts (recordings/screenshots) — lives under `/app/data`
inside the container, which is the named Docker volume `portico-data`. It
survives `docker compose down`, image rebuilds, and `up -d --build` reruns; the
only thing that removes it is an explicit `docker compose down -v` or
`docker volume rm`.

```bash
docker volume inspect deploy_portico-data   # host path backing the volume
```

To back it up, stop the container and copy that path (or `docker run --rm -v
deploy_portico-data:/data -v "$PWD":/backup busybox tar czf /backup/portico-data.tgz -C /data .`).

**Auth profiles** — persisted logins (storage-state plus, where a portal needs
it, a persistent browser profile) that let a run skip login/2FA live under
`.portico/profiles` inside the container, backed by its own named volume,
`portico-profiles`, mounted at `/app/.portico` (see `deploy/docker-compose.yml`).
Before [ADR-0004](decisions/0004-own-engine.md) this state sat at
`.libretto/profiles`, outside any volume, so an image rebuild silently dropped
every persisted login; that's fixed now — profiles survive rebuilds the same
way the SQLite store does. If you're upgrading from an older Portico, a
read-fallback shim migrates any existing `.libretto/profiles` state to
`.portico/profiles` automatically the first time each profile is used, so
nothing needs to be moved by hand.

Between the two named volumes, rerunning `up -d --build` after pulling changes
rebuilds the console/engine image and reattaches both — nothing else is
stateful.

## Local-only, by design

This is the entire deployment — no managed database, no cloud queue, no
external control plane. The container:

- serves the console (Next.js) on `:4400`,
- runs engine flows as a subprocess of the console, driving a real,
  locally-launched Chromium,
- reads/writes its own SQLite file on the volume above.

The one thing that doesn't fully work headless: **starting an interactive
browser session** (the "Sessions" tab, used for a human to log into a portal
the first time) launches a real, visible browser window on the machine running
the console — which, in this container, has no display. Everything downstream
of an established session (running confirmed flows, self-heal, replay) works
fully headless; that one first-login step is a known constraint of running the
console inside a headless container, not something this Compose setup papers
over.

## Updating

```bash
git pull
docker compose -f deploy/docker-compose.yml up -d --build
```

The volume (and everything in it) is untouched by a rebuild.

## Members & access control (optional)

The console is open by default — no login, no roles — which is right for
the common case of one person on their own machine. Access control turns
on **by itself the moment the first member exists**, and everything about
membership is managed from the console: no env editing, no restarts.

The only prerequisite is a signing secret for session cookies:
`PORTICO_AUTH_SECRET`, or (the common case) the `PORTICO_ENCRYPTION_KEY`
you already set — sign-in refuses to mint sessions if neither is present.

### The lifecycle, end to end

1. **Bootstrap** — open **Settings → Members** on a fresh console and
   "Create the first admin". You get a token, shown exactly once. From
   that moment the console requires sign-in (allow up to ~10s for the
   enforcement probe's cache).
2. **Sign in** — `/login`, paste the token (or follow an invite link,
   which prefills it). The server verifies it against the members table
   and sets a signed, `httpOnly` `portico_session` cookie
   (`PORTICO_SESSION_TTL_HOURS`, default 12).
3. **Add / invite members** — Settings → Members → Add: name + role. The
   new member's token appears once, with a `/login?token=…` invite link to
   share over a private channel. Raw tokens are never stored (only a
   hash) and can never be shown again — if one is lost, disable that
   member and add them again.
4. **Disable / enable** — per-row on the same page. Disabling blocks the
   member's **next sign-in**; an already-minted session stays valid until
   its expiry — worst-case revocation lag equals the session TTL.
5. **Sign out** — the sidebar's signed-in row; expires the session cookie
   server-side.

### Roles

- **viewer** — read-only: every page, every `GET`/`HEAD` API route.
- **operator** — viewer, plus everyday mutations: sessions, recordings,
  creating/saving/validating/confirming flows, runs.
- **admin** — everything, including what `operator` cannot reach:
  `/api/config` (Settings' backing route, any method), mutations under
  `/api/connectors*`, `DELETE /api/flows/[id]`, and member management
  (`/api/members*`). A signed-in non-admin who navigates to a management
  page is sent to `/`, not `/login` — they're authenticated, just not
  admin.

Denials: missing/invalid credentials → `401` JSON on `/api/*`, redirect to
`/login` for pages. Valid identity, insufficient role → `403` JSON on
`/api/*`. `/login`, the auth routes (`/api/auth/*`, `/api/members/bootstrap`
— which self-guards on "zero members"), and static assets are always
reachable.

### Static env tokens (scripts / CI / docker fallback)

`PORTICO_RBAC_TOKENS` still works and is checked *before* the members
table — useful for headless automation that sends
`Authorization: Bearer <token>` per request, or for a fully
env-provisioned container. Format: comma-separated `role:token` or
`role:name:token` entries (name defaults to the role; tokens under 8 chars
are dropped with a warning). Env-token changes require a restart — that's
the trade-off that motivated DB members. When both are configured, the
Members section shows a small banner listing the active env identities.

### The CLI is out of scope

RBAC here only gates the console's HTTP surface (`apps/console/middleware.ts`).
The `portico` CLI talks to the local SQLite store directly — if you can run
the CLI on this machine, you already have shell access, which is a
strictly stronger position than "holds an admin token." Local shell access
is treated as equivalent to admin; there's no separate CLI-level gate.
