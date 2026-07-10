import Link from "next/link";
import { readAudit } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Compact one-line JSON preview of an audit event's detail payload, truncated
 *  so a wide/nested object never blows out the row height. The full value is
 *  still available via the title tooltip on hover. */
function detailPreview(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "—";
  const json = JSON.stringify(detail);
  return json.length > 60 ? `${json.slice(0, 60)}…` : json;
}

export default async function AuditPage() {
  const events = readAudit();
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Audit</b></div>
      </div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">Audit</h1>
          <p className="page-sub">
            An append-only ledger of actions taken across the platform — flow edits, run outcomes, connector
            changes. Read-only: nothing here can be edited or removed from the console.
          </p>
        </div>

        {events.length === 0 ? (
          <div className="panel empty rise rise-2">
            <div className="empty-t">No audit events yet</div>
            Actions taken via the CLI or console will show up here.
          </div>
        ) : (
          <div className="panel rise rise-2">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th><th>Actor</th><th>Action</th><th>Run</th><th>Target</th><th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="mono" style={{ color: "var(--ink-3)", fontSize: 12.5, whiteSpace: "nowrap" }}>{e.ts}</td>
                    <td>{e.actor}</td>
                    <td><span className="chip">{e.action}</span></td>
                    <td className="mono">
                      {e.runId ? (
                        <Link href={`/runs/${e.runId}`}>{e.runId}</Link>
                      ) : (
                        <span style={{ color: "var(--ink-3)" }}>—</span>
                      )}
                    </td>
                    <td
                      className="mono"
                      style={{
                        color: "var(--ink-2)",
                        fontSize: 12.5,
                        maxWidth: 220,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={e.target}
                    >
                      {e.target ?? <span style={{ color: "var(--ink-3)" }}>—</span>}
                    </td>
                    <td
                      className="mono"
                      style={{
                        color: "var(--ink-3)",
                        fontSize: 12,
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={e.detail ? JSON.stringify(e.detail) : undefined}
                    >
                      {detailPreview(e.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
