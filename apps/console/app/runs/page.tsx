import { cookies } from "next/headers";
import { listRuns } from "@/lib/store";
import { fmtDuration, fmtRelative, tierLabel } from "@/lib/format";
import { RunButton } from "@/components/run-button";
import { RowLink } from "@/components/row-link";

export const dynamic = "force-dynamic";

export default async function RunsPage() {
  const scope = (await cookies()).get("portico-connector")?.value?.trim() || "";
  const scoped = scope && scope !== "all" ? scope : "";
  const runs = listRuns().filter((r) => (scoped ? r.connector === scoped : true));
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Runs</b></div>
        <RunButton label="Run smoke flow" />
      </div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">
            Runs
            {scoped && (
              <span style={{ fontFamily: "var(--font-body)", fontWeight: 500, fontSize: 15, color: "var(--ink-3)" }}>
                {" · scoped to "}
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>{scoped}</span>
              </span>
            )}
          </h1>
          <p className="page-sub">
            Every execution, with step-level traces and a clear reason on failure. Click a run to inspect and resume.
            {scoped && " Filtered by the connector switcher in the sidebar — pick “All connectors” to see everything."}
          </p>
        </div>

        {runs.length === 0 ? (
          <div className="panel empty rise rise-2">
            <div className="empty-t">No runs{scoped ? ` for ${scoped}` : ""}</div>
            {scoped
              ? "This connector has no runs yet — validate or run one of its flows, or switch to All connectors."
              : "Validate or run a flow to see executions here."}
          </div>
        ) : (
        <div className="panel rise rise-2">
          <table className="table">
            <thead>
              <tr>
                <th>Flow</th><th>Engine</th><th>Tier</th><th>Mode</th><th>Status</th><th>Steps</th><th>Duration</th><th style={{ textAlign: "right" }}>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <RowLink key={r.id} href={`/runs/${r.id}`} className="rowlink">
                  <td className="flowcell">{r.flow}<small>{r.connector}{r.instance ? ` · ${r.instance}` : ""} · {r.id}</small></td>
                  <td style={{ color: "var(--ink-2)" }}>{r.engine}</td>
                  <td><span className="chip">{tierLabel[r.tier]}</span></td>
                  <td style={{ color: "var(--ink-3)", fontSize: 12.5 }}>{r.mode}</td>
                  <td><span className={`badge ${r.status}`}><span className="d" />{r.status}</span></td>
                  <td className="tnum">{r.steps.length}</td>
                  <td className="tnum">{fmtDuration(r.durationMs)}</td>
                  <td style={{ textAlign: "right", color: "var(--ink-3)" }}>{fmtRelative(r.startedAt)}</td>
                </RowLink>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </>
  );
}
