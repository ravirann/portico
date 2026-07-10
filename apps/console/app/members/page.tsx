import { parseTokens } from "@/lib/rbac";
import { MembersManager } from "@/components/members-manager";

export const dynamic = "force-dynamic";

/**
 * Admin-only helper for managing PORTICO_RBAC_TOKENS (see lib/rbac.ts —
 * requiredRole treats /members as admin-only, and middleware redirects a
 * signed-in non-admin here back to / rather than to /login) and
 * docs/DEPLOY.md's "Managing members" section.
 *
 * IMPORTANT: middleware runs on the edge and only ever reads
 * process.env.PORTICO_RBAC_TOKENS — there is no user database anywhere in
 * this app. This page reads that env var and renders a helper over it: the
 * table below reflects the console's *current* membership, and "Add
 * member" / "Revoke" just prepare a new value for you to paste back into
 * your env and restart the console with. No server mutation happens here.
 */
export default function MembersPage() {
  const config = parseTokens(process.env.PORTICO_RBAC_TOKENS);

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Members</b></div>
      </div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">Members</h1>
          <p className="page-sub">
            Who can sign in to this console, and what they can do. Membership lives entirely in the{" "}
            <span className="mono">PORTICO_RBAC_TOKENS</span> environment variable — this page is a helper for
            building that value, not a live user store.
          </p>
        </div>

        {!config.enabled ? (
          <div className="panel empty rise rise-2" style={{ padding: "48px 20px" }}>
            <div className="empty-t">RBAC is off</div>
            <div style={{ maxWidth: 480, margin: "0 auto" }}>
              This console is fully open right now — anyone who can reach it has full access, so there are no
              members to manage. Set <span className="mono">PORTICO_RBAC_TOKENS</span> to turn on role-gated
              access:
            </div>
            <pre
              className="code mono"
              style={{ textAlign: "left", marginTop: 18, maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}
            >
              PORTICO_RBAC_TOKENS=admin:you:tok_change_me_a1
            </pre>
            <div style={{ marginTop: 4 }}>
              Then restart the console. See docs/DEPLOY.md&rsquo;s &ldquo;RBAC (optional)&rdquo; section for the
              full format, roles, and how to present a token.
            </div>
          </div>
        ) : (
          <div className="rise rise-2">
            <MembersManager
              members={[...config.tokens.entries()].map(([token, role]) => ({
                token,
                role,
                name: config.names.get(token) ?? role,
              }))}
            />
          </div>
        )}
      </div>
    </>
  );
}
