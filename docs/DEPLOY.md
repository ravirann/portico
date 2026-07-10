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

Nothing else is stateful: rerunning `up -d --build` after pulling changes
rebuilds the console/engine image and reattaches the same volume.

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

## RBAC (optional)

The console is open by default — no login, no roles — which is right for
the common case of one person running this on their own machine. Set
`PORTICO_RBAC_TOKENS` to turn on role-gated access instead; leave it unset
(or empty) and nothing changes: same fully-open console as today, so
existing single-user setups are unaffected.

```bash
# Anywhere the console process reads its environment — e.g. deploy/.env for
# Docker Compose (copy deploy/.env.example to deploy/.env first):
PORTICO_RBAC_TOKENS=admin:tok_change_me_a1,operator:tok_change_me_o1,viewer:tok_change_me_v1
```

For Compose specifically: add that line to `deploy/.env`, then add a
`PORTICO_RBAC_TOKENS: ${PORTICO_RBAC_TOKENS:-}` entry to the `console`
service's `environment:` block in `deploy/docker-compose.yml` (alongside
`PORTICO_ENCRYPTION_KEY` and the other passthrough vars) so it actually
reaches the container.

Format: comma-separated `role:token` pairs, or `role:name:token` to also
give that entry a display name (shown in the sidebar and on the Members
page) — the name defaults to the role string when omitted, so existing
`role:token` entries don't need to change. Repeat a role for multiple
tokens (`viewer:tok_a,viewer:tok_b`). Tokens are opaque strings — generate
one with `openssl rand -hex 24` or similar, or let the Members page (see
"Managing members" below) generate one for you. Tokens under 8 characters
are rejected: the console logs a warning to stderr at startup and drops
that one entry; the rest of the list still loads.

### Roles

- **viewer** — read-only: every page, every `GET`/`HEAD` API route.
- **operator** — viewer, plus the everyday mutations: starting sessions and
  recordings, creating/saving/validating/confirming/refining flows,
  kicking off runs.
- **admin** — everything, including the routes `operator` cannot reach:
  - `/api/config`, any method — the Settings page's backing route (global
    LLM provider/model/API key). There's no literal `/api/settings` path in
    this app; `/api/config` is what the Settings page posts to, so it's
    treated as the settings-equivalent route and is admin-only end to end,
    not just for writes.
  - any mutation (`POST`/`PUT`/`PATCH`/`DELETE`) under `/api/connectors*` —
    creating a connector, deleting one, saving its variables. Reading
    connector data (`GET`) stays available to `viewer`.
  - `DELETE /api/flows/[id]` — deleting a flow version (or every version of
    its key).
  - the **Members** page (`/members`) — the helper for managing
    `PORTICO_RBAC_TOKENS` itself (see "Managing members" below). A
    signed-in `viewer`/`operator` who navigates there is redirected to `/`,
    not `/login` — they're already authenticated, just not admin.

### Presenting a token

Two ways to authenticate a request: an `Authorization: Bearer <token>`
header, or a `portico_token` cookie.

`/login` is the cookie path — paste a token, it's written to
`document.cookie` client-side, and you're redirected to `/`. **That cookie
is intentionally not `httpOnly`**: nothing sets it server-side, so in
principle a script on the page could read it back. That's an accepted
trade-off for a minimal, backend-free login flow on a local, self-hosted
console — it's not the trade-off you'd want if you ever exposed this
pattern to the open internet. `SameSite=Lax` limits cross-site sending.
Sign out from the sidebar's signed-in block (bottom of the sidebar, shown
whenever RBAC is on and you're signed in) — it clears the `portico_token`
cookie and sends you back to `/login`. You can also just clear the cookie
yourself (devtools, or an incognito window); either way, the token itself
stays valid until it's removed from `PORTICO_RBAC_TOKENS` and the console
restarts (see "Managing members" below).

A missing or unrecognized token gets `401` JSON (`{"error": "..."}`) from
`/api/*` routes, and a redirect to `/login` from page navigations. A
*recognized* token with insufficient role gets `403` JSON from `/api/*`
routes, and — for the one page this currently applies to, `/members` — a
redirect to `/` rather than `/login` (see the Members bullet above; an
already-signed-in user bouncing to `/login` would just re-present the same
token and land right back where they started). `/login` itself, and
framework/static assets (`_next/*`, `favicon.ico`, `/brand/*`), are always
reachable, RBAC on or off.

### Managing members

Add members from the console itself: sign in as an admin and open
**Members** (`/members`). It reads the current `PORTICO_RBAC_TOKENS` value
and helps you build the next one — there's still no user database; the
page is a helper over that one environment variable, and every change it
produces still has to be pasted into your env and followed by a restart.

- **Add a member** — enter a name and pick a role; the page generates a
  token in your browser (nothing is sent anywhere) and shows you the full
  updated `PORTICO_RBAC_TOKENS` line to copy, plus a `/login?token=...`
  invite link that prefills (but doesn't submit) the login form. Share the
  invite link over a private channel — it's as sensitive as the token
  itself.
- **Revoke a member** — the Members page's per-row "Revoke" control shows
  you `PORTICO_RBAC_TOKENS` with that entry already stripped out, ready to
  copy. There's no session to invalidate server-side, so the token keeps
  working until you paste the new value in and restart.
- **By hand** — the Members page is optional; `PORTICO_RBAC_TOKENS` is
  just a plain comma-separated string, so you can always add, rename, or
  remove entries directly.
- **Named tokens** — entries can be `role:token` (as above) or
  `role:name:token`, e.g. `operator:ravi:tok_change_me_o1`. The name is a
  display label only (sidebar, Members table); omit it and it defaults to
  the role.
- **Every change requires a restart.** Middleware reads
  `PORTICO_RBAC_TOKENS` once at process start — adding, renaming, or
  revoking a member never takes effect until the console process restarts
  with the new value.

### The CLI is out of scope

RBAC here only gates the console's HTTP surface (`apps/console/middleware.ts`).
The `portico` CLI talks to the local SQLite store directly — if you can run
the CLI on this machine, you already have shell access, which is a
strictly stronger position than "holds an admin token." Local shell access
is treated as equivalent to admin; there's no separate CLI-level gate.
