import { NextResponse } from "next/server";
import { addMember, readMembers } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = new Set(["viewer", "operator", "admin"]);

/**
 * Add a member (admin-only — middleware gates every /api/members* mutation;
 * the x-portico-role assertion below is defense-in-depth for the open-mode
 * edge where enforcement is off because no member exists yet: then ANYONE
 * local may create members, which is exactly the bootstrap semantics).
 * Returns the raw token EXACTLY ONCE — it is never stored or queryable.
 */
export async function POST(req: Request) {
  const role = req.headers.get("x-portico-role");
  const enforcementOn = readMembers().length > 0 || Boolean(process.env.PORTICO_RBAC_TOKENS?.trim());
  if (enforcementOn && role !== "admin") {
    return NextResponse.json({ error: "Only an admin can add members." }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { name?: string; role?: string };
  const name = (body.name ?? "").trim();
  const memberRole = (body.role ?? "").trim();
  if (!name) return NextResponse.json({ error: "A member name is required." }, { status: 400 });
  if (!ROLES.has(memberRole)) return NextResponse.json({ error: "Role must be viewer, operator, or admin." }, { status: 400 });

  const created = addMember(name, memberRole as "viewer" | "operator" | "admin");
  if (!created) return NextResponse.json({ error: "Could not create the member — see console logs." }, { status: 500 });
  return NextResponse.json(created);
}
