import { headers } from "next/headers";
import { readConfig, readMembers } from "@/lib/store";
import { parseTokens } from "@/lib/rbac";
import { SettingsForm } from "@/components/settings-form";
import { MembersManager } from "@/components/members-manager";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const entries = readConfig({ scope: "global", category: "llm" });
  const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
  const initial = {
    provider: byKey.provider?.value ?? "",
    model: byKey.model?.value ?? "",
    apiKeyConfigured: Boolean(byKey.api_key),
  };

  // Members section (DB-backed; see components/members-manager.tsx).
  // Render rules: admins manage members; the open console (no members yet,
  // no env tokens) shows the bootstrap card to whoever is at the keyboard —
  // that IS the first-run flow; signed-in non-admins get a short note
  // instead of the management UI (the APIs behind it are admin-gated by
  // middleware anyway — this is presentation, not the security boundary).
  const hdrs = await headers();
  const role = hdrs.get("x-portico-role");
  const user = hdrs.get("x-portico-user");
  const members = readMembers();
  const envConfig = parseTokens(process.env.PORTICO_RBAC_TOKENS);
  const enforcementOn = members.length > 0 || envConfig.enabled;
  const canManage = role === "admin" || !enforcementOn;

  return (
    <>
      <div className="topbar"><div className="crumb"><b>Settings</b></div></div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">Settings</h1>
          <p className="page-sub">
            The default model used to resolve locators, refine flows and heal at run time.
            Connectors can override this on their edit page. Secrets are stored locally and never displayed.
          </p>
        </div>
        <div className="rise rise-2">
          <SettingsForm initial={initial} />
        </div>

        <div className="rise rise-3" style={{ marginTop: 36 }} id="members">
          <div className="page-head" style={{ marginBottom: 14 }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>Members</h2>
            <p className="page-sub" style={{ marginTop: 6 }}>
              Who can sign in to this console, and what they can do. Members live in the local store —
              add one and share its invite link; disabling blocks their next sign-in.
            </p>
          </div>

          {canManage ? (
            <>
              <MembersManager members={members} bootstrap={members.length === 0} />
              {envConfig.enabled && (
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 12 }}>
                  Static env tokens are also active (scripts / CI / docker fallback):{" "}
                  {[...envConfig.names.values()].map((n, i) => (
                    <span key={i} className="chip" style={{ marginRight: 6 }}>{n}</span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="panel" style={{ padding: "18px 20px", fontSize: 13, color: "var(--ink-2)" }}>
              Only an admin can manage members. You're signed in as{" "}
              <b>{user ?? "unknown"}</b> ({role ?? "no role"}).
            </div>
          )}
        </div>
      </div>
    </>
  );
}
