# syntax=docker/dockerfile:1.7
#
# Portico self-host image — ONE container, two jobs at runtime:
#
#   1. Serve the Next.js console (production build) on :4400.
#   2. Run engine flows as a CLI *subprocess* the console shells out to —
#      apps/console/lib/actions.ts and lib/store.ts spawn
#      `node --import tsx apps/cli/src/index.ts ...` with cwd set to the repo
#      root (they compute REPO_ROOT = resolve(process.cwd(), "../..") from
#      the console's own cwd). That subprocess drives a real Chromium via
#      Playwright/libretto and owns the SQLite store — so this image needs
#      Chromium + its OS deps, not just Node, and the console's working
#      directory at runtime MUST be <repo-root>/apps/console for that
#      relative-path math to land on the repo root. `pnpm --filter
#      @portico/console start` (used below) guarantees that: pnpm always runs
#      a package's scripts with cwd = that package's own directory.
#
# Base image = the official Playwright image, version-pinned to MATCH the
# `playwright` version this workspace actually installs — 1.61.1, per
# pnpm-lock.yaml (packages/engine and packages/author both depend on
# playwright ^1.49.0, which resolves to 1.61.1). Matching versions means
# `pnpm install`'s Playwright postinstall finds the browser revision it wants
# already unpacked at PLAYWRIGHT_BROWSERS_PATH (baked into this base image)
# and skips downloading anything.
#
# NOTE ON COPY STYLE: this Dockerfile copies explicit paths instead of
# `COPY . .`. The working tree can contain things that must never end up in
# an image layer — a filled-in `.env`, the gitignored `data/` directory
# (SQLite DB + run artifacts), and gitignored connector instance overrides
# under connectors/**/*.local.yaml (real portal hostnames). Only creating
# files under deploy/ (not a repo-root .dockerignore) ruled out the usual
# fix, so the safe allowlist below is deliberate, not an oversight.

FROM mcr.microsoft.com/playwright:v1.61.1-jammy AS base
WORKDIR /app
# Root package.json pins "packageManager": "pnpm@9.0.0" — install that exact
# version rather than whatever corepack/npm would default to.
RUN npm install -g pnpm@9.0.0

# ---------------------------------------------------------------------------
# deps: install the whole pnpm workspace from the lockfile. Only manifests are
# copied here so this (slow) layer stays cached across source-only changes.
# ---------------------------------------------------------------------------
FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/flow-spec/package.json packages/flow-spec/package.json
COPY packages/vault/package.json packages/vault/package.json
COPY packages/store/package.json packages/store/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/author/package.json packages/author/package.json

# Do NOT add --prod / NODE_ENV=production here: `tsx` (root devDependency) is
# a runtime dependency of the CLI subprocess (its bin shebang is
# `#!/usr/bin/env -S node --import tsx`, and console spawns it the same way),
# so devDependencies must stay installed in the final image.
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: `tsc -b` the packages, then `next build` the console.
#
# Most of the runtime (the CLI itself, and any workspace package it imports)
# runs straight off *.ts via the tsx loader — package.json "exports" fields
# point at "./src/index.ts", so dist/ is NOT needed for that path. It IS
# needed for three helper scripts that run under *plain* node (no tsx loader)
# and `require("packages/store/dist/index.js")` directly: scripts/serve-
# browser.mjs (the long-lived browser a "session-start" launches) and
# packages/author/{author-cli,run-author}.mjs (agent authoring). Without the
# build these degrade silently (a caught error just disables session
# tracking) instead of erroring loudly, so build it.
# ---------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.json tsconfig.base.json ./
COPY apps/cli/tsconfig.json apps/cli/src apps/cli/
COPY apps/console/tsconfig.json apps/console/next.config.mjs apps/console/next-env.d.ts apps/console/
COPY apps/console/app apps/console/app
COPY apps/console/lib apps/console/lib
COPY apps/console/components apps/console/components
COPY apps/console/public apps/console/public
COPY packages/flow-spec/tsconfig.json packages/flow-spec/src packages/flow-spec/
COPY packages/vault/tsconfig.json packages/vault/src packages/vault/
COPY packages/store/tsconfig.json packages/store/src packages/store/
COPY packages/engine/tsconfig.json packages/engine/src packages/engine/
COPY packages/author/tsconfig.json packages/author/src packages/author/author-cli.mjs packages/author/run-author.mjs packages/author/
# Helper scripts the CLI shells out to (session-start's long-lived browser,
# recording attach) and the flow the console falls back to when no flowId is
# posted to POST /api/runs (`body.flow ?? "examples/smoke.flow.yaml"`).
COPY scripts scripts
COPY examples examples

RUN pnpm run build
RUN pnpm --filter @portico/console build

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

# Chromium's sandbox intentionally refuses to add value for a root process,
# so Playwright's own images run as root by default and accept a disabled
# sandbox for "executing trusted code" (see https://playwright.dev/docs/docker).
# Portico only drives portals/flows the operator configured — not arbitrary
# untrusted URLs — so that default is kept here rather than switching to the
# docs' alternative (a non-root user + a custom seccomp profile granting
# clone/setns/unshare), which is real hardening but needs an extra file this
# task's scope doesn't include. Operators who want that isolation can layer
# it on following the link above.
#
# --ipc=host and --init (below, set in docker-compose.yml) are the other two
# pieces of Playwright's own Docker guidance: the former avoids Chromium
# crashing under the default tiny /dev/shm, the latter reaps the zombie
# processes Chromium's multi-process model leaves behind when it isn't PID 1.

RUN mkdir -p /app/data

EXPOSE 4400
VOLUME ["/app/data"]

CMD ["pnpm", "--filter", "@portico/console", "start"]
