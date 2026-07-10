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
