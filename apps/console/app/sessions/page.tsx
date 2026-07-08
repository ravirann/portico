import { cookies } from "next/headers";
import { readSessions } from "@/lib/store";
import { fmtRelative } from "@/lib/format";
import type { SessionView } from "@/lib/types";
import { SessionCloseButton } from "@/components/session-close-button";
import { SessionStart } from "@/components/session-start";

export const dynamic = "force-dynamic";

/** Health pill: active → positive/evergreen, idle → neutral, stale/closed → muted. */
function healthBadge(s: SessionView) {
  if (s.status === "closed") return { cls: "paused", label: "closed" };
  if (s.health === "active") return { cls: "completed", label: "active" };
  if (s.health === "idle") return { cls: "paused", label: "idle" };
  return { cls: "paused", label: "stale" };
}

export default async function SessionsPage() {
  const scope = (await cookies()).get("portico-connector")?.value?.trim() || "";
  const scoped = scope && scope !== "all" ? scope : "";
  const sessions = readSessions().filter((s) => (scoped ? s.connector === scoped : true));

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Sessions</b></div>
      </div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">
            Sessions
            {scoped && (
              <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, fontSize: 15, color: "var(--ink-3)" }}>
                {" · scoped to "}
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{scoped}</span>
              </span>
            )}
          </h1>
          <p className="page-sub">
            Live and recent browser sessions. Validation and recording attach to an active session&apos;s
            CDP endpoint — keep one running to validate or record flow drafts.
            {scoped && " Filtered by the connector switcher in the sidebar — pick “All connectors” to see everything."}
          </p>
          <div style={{ marginTop: 18 }}>
            <SessionStart connector={scoped || undefined} />
          </div>
        </div>

        {sessions.length === 0 ? (
          <div className="panel empty rise rise-2">
            <div className="empty-t">No sessions{scoped ? ` for ${scoped}` : ""}</div>
            Use <b>Start session</b> above to launch a local browser here.
          </div>
        ) : (
          <div className="panel rise rise-2">
            <table className="table">
              <thead>
                <tr>
                  <th>Session</th><th>Connector</th><th>Profile</th><th>Health</th><th>CDP endpoint</th><th>Started</th><th>Last active</th><th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const h = healthBadge(s);
                  return (
                    <tr key={s.id}>
                      <td className="flowcell mono">{s.id}</td>
                      <td style={{ color: "var(--ink-2)" }}>{s.connector ?? <span style={{ color: "var(--ink-3)" }}>—</span>}</td>
                      <td style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{s.profile ?? "—"}</td>
                      <td><span className={`badge ${h.cls}`}><span className="d" />{h.label}</span></td>
                      <td className="mono" style={{ color: "var(--ink-3)", fontSize: 12 }}>{s.cdpEndpoint ?? "—"}</td>
                      <td style={{ color: "var(--ink-3)" }}>{fmtRelative(s.startedAt)}</td>
                      <td style={{ color: "var(--ink-3)" }}>{fmtRelative(s.lastActiveAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        <SessionCloseButton id={s.id} disabled={s.status === "closed"} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
