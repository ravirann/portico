/**
 * Session recording — best-effort, never fails a run.
 *
 * Two artifacts per run, written under `data/artifacts/<runId>/`:
 *   1. rrweb events (`rrweb.json`) — injected into the page via a CDN <script>,
 *      polled at the end. If injection is blocked (offline / CSP), it degrades to
 *      an empty capture; the run is unaffected.
 *   2. a full-page screenshot per step (`step-<n>.png`), referenced from the
 *      step's `screenshotRef`.
 * Plus a `manifest.json` tying them together; its ref is returned as `rrwebRef`.
 *
 * Every captured *text* payload (rrweb events JSON) is passed through
 * `@portico/vault`'s `redact` before it is written, so secrets never land in an
 * artifact (docs/ARCHITECTURE.md §6). Screenshots are pixels, not text.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Page } from "playwright";

const RRWEB_CDN = "https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/dist/rrweb.min.js";

export interface Recorder {
  /** Start rrweb capture on the current page (best-effort). */
  start(): Promise<void>;
  /** Full-page screenshot for a step; returns a repo-relative ref or undefined. */
  screenshot(stepIndex: number): Promise<string | undefined>;
  /** Flush rrweb + manifest; returns the `rrwebRef` (manifest path) or undefined. */
  finalize(status: string): Promise<string | undefined>;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_res, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

const NOOP: Recorder = {
  async start() {},
  async screenshot() {
    return undefined;
  },
  async finalize() {
    return undefined;
  },
};

export interface RecorderOptions {
  runId: string;
  artifactsDir: string;
  /** Repo root used to produce short, portable artifact refs. */
  repoRoot: string;
  /** Redact secrets from any captured text before it is written. */
  redactText: (s: string) => string;
  enabled: boolean;
}

export function createRecorder(page: Page, opts: RecorderOptions): Recorder {
  if (!opts.enabled) return NOOP;
  const dir = join(opts.artifactsDir, opts.runId);
  const shots: string[] = [];
  const ref = (p: string) => relative(opts.repoRoot, p) || p;

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return NOOP;
  }

  return {
    async start() {
      try {
        // Best-effort, time-boxed: a blocked/offline CDN must not stall the run.
        await withTimeout(page.addScriptTag({ url: RRWEB_CDN }), 5000);
        await page.evaluate(() => {
          const w = globalThis as unknown as Record<string, unknown>;
          const rr = w.rrweb as { record?: (o: unknown) => void } | undefined;
          if (!rr?.record) return;
          const events: unknown[] = ((w.__porticoRrweb as unknown[]) = []);
          rr.record({ emit: (e: unknown) => events.push(e) });
        });
      } catch {
        /* injection blocked — degrade to screenshots only */
      }
    },

    async screenshot(stepIndex) {
      try {
        const file = join(dir, `step-${stepIndex}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
        return ref(file);
      } catch {
        return undefined;
      }
    },

    async finalize(status) {
      let eventCount = 0;
      try {
        const events = await page.evaluate(() => {
          const w = globalThis as unknown as Record<string, unknown>;
          return (w.__porticoRrweb as unknown[]) ?? [];
        });
        eventCount = Array.isArray(events) ? events.length : 0;
        const json = opts.redactText(JSON.stringify(events ?? []));
        writeFileSync(join(dir, "rrweb.json"), json, "utf8");
      } catch {
        /* page may be closed already — fine */
      }
      try {
        const manifest = {
          runId: opts.runId,
          status,
          rrwebEvents: eventCount,
          rrwebFile: eventCount > 0 ? "rrweb.json" : null,
          screenshots: shots.map((s) => ref(s)),
          capturedAt: new Date().toISOString(),
        };
        const manifestPath = join(dir, "manifest.json");
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
        return ref(manifestPath);
      } catch {
        return undefined;
      }
    },
  };
}
