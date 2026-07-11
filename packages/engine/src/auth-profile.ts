/**
 * Auth-profile persistence — the "log in once, hands-free after" fix.
 *
 * A per-target browser storage-state is persisted under
 * `.portico/profiles/<name>.json`. A run started with `--profile <name>`
 * loads that state on launch (skipping login) and writes the updated state
 * back on success.
 *
 * `launch.ts`'s ephemeral launcher only accepts a `storageStatePath` string,
 * so this module owns the mapping profileId → profile path, loads it as the
 * launch storage-state, and (when `refresh`) writes the post-run
 * `context.storageState()` back to the same file.
 *
 * ADR-0004 moved this directory from `.libretto/profiles/` — which sat
 * outside the Docker data volume, so image rebuilds silently dropped every
 * persisted login (see docs/DEPLOY.md and deploy/docker-compose.yml's
 * `portico-profiles` volume) — to `.portico/profiles/`, inside it.
 * `migrateLegacyProfile` below is the one-time, read-fallback shim: existing
 * `.libretto/profiles/` state is copied forward transparently on first use
 * rather than silently orphaned.
 */

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BrowserContext } from "playwright";

/**
 * Normalize a profile id to a safe filename stem (lowercase, non-alphanumerics
 * → single dash).
 */
function normalizeProfileName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "default"
  );
}

export interface ResolvedProfile {
  name: string;
  /** Absolute path to `.portico/profiles/<name>.json` (storage-state snapshot). */
  path: string;
  /** Path to hand to `launchEphemeralBrowser({ storageStatePath })`, if it exists. */
  loadPath: string | undefined;
  /**
   * Absolute path to `.portico/profiles/<name>.userdata/` — a PERSISTENT
   * on-disk browser profile. Preferred over the storage-state snapshot because
   * it keeps sessionStorage + cache + fingerprint, so login survives across
   * runs on portals (like Epic/MyChart) that a cookie snapshot can't restore.
   * Shared with `scripts/serve-browser.mjs`, so a login made there also
   * serves runs that pass the same `--profile` name.
   */
  userDataDir: string;
  refresh: boolean;
}

export function profilesDir(cwd = process.cwd()): string {
  return resolve(cwd, ".portico", "profiles");
}

/** The pre-ADR-0004 location — read-fallback only, never written to. */
function legacyProfilesDir(cwd = process.cwd()): string {
  return resolve(cwd, ".libretto", "profiles");
}

/**
 * One-time copy-forward: for each artifact (the `.json` storage-state
 * snapshot, the `.userdata` persistent-context directory) that's missing at
 * the new (`.portico`) location but present at the old (`.libretto`) one,
 * copy it forward before the caller reads/writes anything at the new
 * location. Idempotent — once copied, the new location has it, so later
 * calls see nothing to migrate. Best-effort: a failed copy must not fail the
 * run, same as `refreshProfile` below — it just means this run starts fresh,
 * same as any other profile-not-found case.
 */
function migrateLegacyProfile(name: string, cwd?: string): void {
  const newDir = profilesDir(cwd);
  const oldDir = legacyProfilesDir(cwd);
  const newJson = join(newDir, `${name}.json`);
  const oldJson = join(oldDir, `${name}.json`);
  const newUserData = join(newDir, `${name}.userdata`);
  const oldUserData = join(oldDir, `${name}.userdata`);

  const migrateJson = !existsSync(newJson) && existsSync(oldJson);
  const migrateUserData = !existsSync(newUserData) && existsSync(oldUserData);
  if (!migrateJson && !migrateUserData) return;

  try {
    mkdirSync(newDir, { recursive: true });
    if (migrateJson) cpSync(oldJson, newJson);
    if (migrateUserData) cpSync(oldUserData, newUserData, { recursive: true });
    console.log(`↻ migrated auth profile "${name}" from .libretto/profiles to .portico/profiles (ADR-0004, one-time)`);
  } catch {
    /* best-effort — see doc comment above */
  }
}

/** Map a caller-supplied profile id to a normalized on-disk auth profile. */
export function resolveProfile(
  profileId: string,
  opts: { refresh?: boolean; cwd?: string } = {},
): ResolvedProfile {
  const name = normalizeProfileName(profileId);
  migrateLegacyProfile(name, opts.cwd);
  const dir = profilesDir(opts.cwd);
  const path = join(dir, `${name}.json`);
  return {
    name,
    path,
    loadPath: existsSync(path) ? path : undefined,
    userDataDir: join(dir, `${name}.userdata`),
    refresh: opts.refresh ?? true,
  };
}

/**
 * Persist the (possibly updated) trusted session back to the profile file so the
 * next run skips login. Best-effort: a write failure must not fail the run.
 */
export async function refreshProfile(
  profile: ResolvedProfile,
  context: BrowserContext,
): Promise<boolean> {
  if (!profile.refresh) return false;
  try {
    const state = await context.storageState();
    mkdirSync(dirname(profile.path), { recursive: true });
    writeFileSync(profile.path, JSON.stringify(state, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
