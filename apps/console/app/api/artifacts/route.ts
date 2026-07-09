import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Repo root, resolved the same way as lib/store.ts (console cwd is apps/console).
const REPO_ROOT = resolve(process.cwd(), "../..");
// The only directory artifacts may ever be served from.
const DATA_ROOT = resolve(REPO_ROOT, "data");

/**
 * GET /api/artifacts?path=<repo-relative-ref>
 *
 * Serves a per-step screenshot PNG by its repo-root-relative ref (as stored on
 * StepView.screenshotRef, e.g. "data/<runId>/step-<n>.png"). Next cannot serve
 * these directly since they live outside public/.
 *
 * Security: this is a path-traversal-sensitive endpoint. The ref is resolved
 * against the repo root and then STRICTLY validated — the resolved absolute path
 * must stay inside <repoRoot>/data (checked via path.relative, rejecting any
 * result that escapes with ".." or is absolute) AND must end in ".png". Any
 * validation failure or missing file returns a bare 404 that leaks no paths.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const ref = new URL(req.url).searchParams.get("path");
  if (!ref) return new NextResponse(null, { status: 404 });

  const abs = resolve(REPO_ROOT, ref);
  const rel = relative(DATA_ROOT, abs);
  // rel starts with ".." (or is absolute) whenever abs is outside DATA_ROOT.
  if (rel.startsWith("..") || isAbsolute(rel) || !abs.endsWith(".png")) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const bytes = await readFile(abs);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
