/**
 * Libretto **auth-profile** persistence — the "log in once, hands-free after" fix.
 *
 * Libretto persists a browser storage-state per named profile under
 * `.libretto/profiles/<name>.json`. A workflow authored with
 * `authProfile: { name, refresh: true }` loads that state on launch (skipping
 * login) and writes the updated state back on success.
 *
 * `launchBrowser` only accepts a `storageStatePath` string, so this module owns
 * the mapping profileId → profile path, loads it as the launch storage-state, and
 * (when `refresh`) writes the post-run `context.storageState()` back to the same
 * file. That closes the loop the old adapter left open (it returned an object the
 * CLI dropped, so login never persisted).
 *
 * The on-disk file is a Playwright storage-state JSON, which is exactly what
 * `storageStatePath` consumes — so profiles written here and by `npx libretto` are
 * interchangeable for the login-skip purpose.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BrowserContext } from "playwright";

/**
 * Normalize a profile id to a safe filename stem, matching Libretto's own
 * profile-name convention (lowercase, non-alphanumerics → single dash). Libretto
 * ships `normalizeProfileName` internally but does not re-export it from its
 * package barrel, so we mirror it here.
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
  /** Absolute path to `.libretto/profiles/<name>.json`. */
  path: string;
  /** Path to hand to `launchBrowser({ storageStatePath })`, if it exists. */
  loadPath: string | undefined;
  refresh: boolean;
}

export function profilesDir(cwd = process.cwd()): string {
  return resolve(cwd, ".libretto", "profiles");
}

/** Map a caller-supplied profile id to a normalized on-disk auth profile. */
export function resolveProfile(
  profileId: string,
  opts: { refresh?: boolean; cwd?: string } = {},
): ResolvedProfile {
  const name = normalizeProfileName(profileId);
  const path = join(profilesDir(opts.cwd), `${name}.json`);
  return {
    name,
    path,
    loadPath: existsSync(path) ? path : undefined,
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
