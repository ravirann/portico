import Link from "next/link";
import { cookies } from "next/headers";
import { readFlows } from "@/lib/store";
import { fmtRelative } from "@/lib/format";
import { IconPlus } from "@/components/icons";
import { FlowDeleteButton } from "@/components/flow-delete-button";
import { RowLink } from "@/components/row-link";
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
        <div
          className="page-head rise rise-1"
          style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}
        >
          <div>
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
              A flow is a versioned automation — the steps — authored against a connector and run against its
              instances. Author one by hand or compile a recording, then validate and confirm a version for
              live execution.
              {scoped && " Filtered by the connector switcher in the sidebar — pick “All connectors” to see everything."}
            </p>
          </div>
          <Link
            href={scoped ? `/flows/new?connector=${encodeURIComponent(scoped)}` : "/flows/new"}
            className="btn btn-primary"
            style={{ flex: "none", marginTop: 4 }}
          >
            <IconPlus className="ico-sm" /> New flow
          </Link>
        </div>

        {flows.length === 0 ? (
          <div className="panel empty rise rise-2">
            <div className="empty-t">No flows yet</div>
            <div style={{ marginBottom: 16 }}>Author one by hand, or record a workflow and compile it to a draft.</div>
            <Link href={scoped ? `/flows/new?connector=${encodeURIComponent(scoped)}` : "/flows/new"} className="btn btn-primary">
              <IconPlus className="ico-sm" /> New flow
            </Link>
          </div>
        ) : (
          <div className="panel rise rise-2">
            <table className="table">
              <thead>
                <tr>
                  <th>Flow</th><th>Version</th><th>Status</th><th>Source</th><th>Connector</th><th>Validation</th><th style={{ textAlign: "right" }}>Created</th><th style={{ width: 1 }} />
                </tr>
              </thead>
              <tbody>
                {flows.map((f) => {
                  const s = statusBadge(f.status);
                  const v = validationBadge(f.validation);
                  return (
                    <RowLink key={f.id} href={`/flows/${f.id}`} className="rowlink">
                      <td className="flowcell">{f.key}<small>{f.id}</small></td>
                      <td className="tnum mono" style={{ color: "var(--ink-2)" }}>v{f.version}</td>
                      <td><span className={`badge ${s.cls}`}><span className="d" />{s.label}</span></td>
                      <td><span className="chip">{f.source}</span></td>
                      <td style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{f.connector ?? "—"}</td>
                      <td><span className={`badge ${v.cls}`}><span className="d" />{v.label}</span></td>
                      <td style={{ textAlign: "right", color: "var(--ink-3)" }}>{fmtRelative(f.createdAt)}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <FlowDeleteButton flowId={f.id} flowKey={f.key} onDone="list" />
                      </td>
                    </RowLink>
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
