/**
 * Local artifact storage. Used to persist rrweb captures, screenshots, and
 * other run byproducts referenced from `runs.rrweb_ref` /
 * `run_steps.screenshot_ref`.
 *
 * Refs are stored relative to the data root (e.g. "artifacts/ab12….png") so the
 * database stays portable; resolve to an absolute path with `getArtifactPath`.
 * Postgres/object-store upgrade later swaps this for S3/GCS behind the same API.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export class Artifacts {
  private readonly artifactsDir: string;

  constructor(private readonly dataDir: string) {
    this.artifactsDir = join(dataDir, "artifacts");
    mkdirSync(this.artifactsDir, { recursive: true });
  }

  /**
   * Persist bytes/text and return a stable ref relative to the data root.
   * @param data raw bytes or a string
   * @param ext extension without a leading dot, e.g. "png" | "json"
   */
  saveArtifact(data: Uint8Array | string, ext: string): string {
    const clean = ext.replace(/^\.+/, "");
    const name = `${randomUUID()}${clean ? "." + clean : ""}`;
    const ref = join("artifacts", name);
    const abs = join(this.dataDir, ref);
    writeFileSync(abs, typeof data === "string" ? data : Buffer.from(data));
    return ref;
  }

  /** Resolve a ref returned by `saveArtifact` to an absolute filesystem path. */
  getArtifactPath(ref: string): string {
    return resolve(this.dataDir, ref);
  }
}
