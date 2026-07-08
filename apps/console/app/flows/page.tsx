import Link from "next/link";
import { cookies } from "next/headers";
import { readFlows } from "@/lib/store";
import { fmtRelative } from "@/lib/format";
import type { FlowView } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Status pill: confirmed is a positive/evergreen state, draft is neutral. */
function statusBadge(status: FlowView["status"]) {
  return status === "confirmed"
    ? { cls: "completed", label: "confirmed" }
    : { cls: "paused", label: "draft" };
}

/** Validation badge: null → neutral, passed → green, failed → red. */
function validationBadge(v: FlowView["validation"]) {
  if (!v) return { cls: "paused", label: "not validated" };
  if (v.passed) return { cls: "completed", label: "validated ✓" };
  return { cls: "failed", label: "failed ✗" };
}

export default async function FlowsPage() {
  const scope = (await cookies()).get("portico-connector")?.value?.trim() || "";
  const scoped = scope && scope !== "all" ? scope : "";
  const flows = readFlows().filter((f) => (scoped ? f.connector === scoped : true));
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Flows</b></div>
      </div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">
            Flows
            {scoped && (
              <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, fontSize: 15, color: "var(--ink-3)" }}>
                {" · scoped to "}
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{scoped}</span>
              </span>
            )}
          </h1>
          <p className="page-sub">
            Auto-generated flow drafts, one per recorded or authored workflow. Review the steps and
            validation status before you confirm a version for live execution.
            {scoped && " Filtered by the connector switcher in the sidebar — pick “All connectors” to see everything."}
          </p>
        </div>

        {flows.length === 0 ? (
          <div className="panel empty rise rise-2">
            <div className="empty-t">No flows yet</div>
            Record a workflow and compile it to create a draft.
          </div>
        ) : (
          <div className="panel rise rise-2">
            <table className="table">
              <thead>
                <tr>
                  <th>Flow</th><th>Version</th><th>Status</th><th>Source</th><th>Connector</th><th>Validation</th><th style={{ textAlign: "right" }}>Created</th>
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => {
                  const s = statusBadge(f.status);
                  const v = validationBadge(f.validation);
                  return (
                    <tr key={f.id} className="rowlink">
                      <td className="flowcell"><Link href={`/flows/${f.id}`}>{f.key}<small>{f.id}</small></Link></td>
                      <td className="tnum mono" style={{ color: "var(--ink-2)" }}>v{f.version}</td>
                      <td><span className={`badge ${s.cls}`}><span className="d" />{s.label}</span></td>
                      <td><span className="chip">{f.source}</span></td>
                      <td style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{f.connector ?? "—"}</td>
                      <td><span className={`badge ${v.cls}`}><span className="d" />{v.label}</span></td>
                      <td style={{ textAlign: "right", color: "var(--ink-3)" }}>{fmtRelative(f.createdAt)}</td>
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
