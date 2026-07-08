import { NextResponse } from "next/server";
import { readConnectors } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimal connector list for the sidebar switcher. Returns key + name only so
 *  the client dropdown can render options without pulling variables/secrets. */
export async function GET() {
  const connectors = readConnectors().map((c) => ({ key: c.key, name: c.name }));
  return NextResponse.json({ connectors }, { status: 200 });
}
