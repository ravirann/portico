import { listConnectors } from "@/lib/connectors";
import { RunButton } from "@/components/run-button";

export const dynamic = "force-dynamic";

export default function ConnectorsPage() {
  const connectors = listConnectors();
  return (
    <>
      <div className="topbar"><div className="crumb"><b>Connectors</b></div></div>
      <div className="content">
        <div className="page-head rise rise-1">
          <h1 className="page-title">Connectors</h1>
          <p className="page-sub">
            A connector is a target site plus its flows and auth — the unit that extends Portico to a new portal.
            Deployments of the same framework share self-heals.
          </p>
        </div>

        {connectors.length === 0 ? (
          <div className="panel empty rise rise-2">
            <div className="empty-t">No connectors yet</div>
            Add one under <span className="mono">connectors/</span> — see the example template.
          </div>
        ) : (
          <div className="stack rise rise-2" style={{ gap: 18 }}>
            {connectors.map((c) => (
              <div key={c.key} className="connector">
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                  <div>
                    <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 560, letterSpacing: "-0.02em" }}>{c.name}</div>
                    <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                      <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.key}</span>
                      {c.framework && <span className="chip">{c.framework}</span>}
                    </div>
                  </div>
                  <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.flows.length} flow{c.flows.length === 1 ? "" : "s"}</span>
                </div>

                <div style={{ marginTop: 16 }}>
                  {c.flows.map((f) => (
                    <div key={f.key} className="flow-row">
                      <div>
                        <div className="fk">
                          {f.key}
                          {f.noBooking && <span className="chip" style={{ marginLeft: 8, color: "var(--ok)", borderColor: "var(--accent-line)", background: "var(--ok-wash)" }}>no-write</span>}
                        </div>
                        {f.description && <div className="fd">{f.description}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 14, color: "var(--ink-3)", fontSize: 13 }}>
          Try the engine end-to-end with no credentials: <RunButton label="Run smoke flow" className="btn" />
        </div>
      </div>
    </>
  );
}
