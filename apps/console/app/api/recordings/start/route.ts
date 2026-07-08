import { NextResponse } from "next/server";
import { runCli } from "@/lib/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Must start AND end alphanumeric; hyphens/underscores allowed inside. Keep in
// sync with the client-side KEY_RE in components/record-flow.tsx.
const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

interface StartBody {
  sessionId?: string;
  key?: string;
  connector?: string;
  baseUrl?: string;
}

/**
 * Start a record-by-demonstration capture: attaches a detached recorder to an
 * ACTIVE browser session (CDP) so the user can demonstrate the workflow in the
 * already-logged-in browser. Returns the recording id; the user then Stops to
 * compile it into a draft.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as StartBody;
  const sessionId = body.sessionId?.trim();
  const key = body.key?.trim();
  if (!sessionId) return NextResponse.json({ error: "Pick an active session to record against." }, { status: 400 });
  if (!key) return NextResponse.json({ error: "A flow key is required." }, { status: 400 });
  if (!KEY_RE.test(key)) {
    return NextResponse.json(
      { error: "Key must be lowercase letters, numbers, hyphens or underscores, and start and end with a letter or number." },
      { status: 400 },
    );
  }

  const args = ["record-start", "--session", sessionId, "--key", key];
  if (body.connector?.trim()) args.push("--connector", body.connector.trim());
  if (body.baseUrl?.trim()) args.push("--base-url", body.baseUrl.trim());
  args.push("--json");

  const { ok, json } = await runCli(args);
  return NextResponse.json(json ?? { error: "No response from CLI" }, { status: ok ? 200 : 400 });
}
