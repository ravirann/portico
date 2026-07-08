import Link from "next/link";
import { listConnectors } from "@/lib/connectors";
import { readConnectors } from "@/lib/store";
import { fmtRelative } from "@/lib/format";
import { RunButton } from "@/components/run-button";
import { ConnectorActions } from "@/components/connector-actions";
import { IconPlus } from "@/components/icons";

export const dynamic = "force-dynamic";

export default function ConnectorsPage() {
  const dbConnectors = readConnectors();
  const seedConnectors = listConnectors();

  return (
    <>
      <div className="topbar"><div className="crumb"><b>Connectors</b></div></div>
      <div className="content">
        <div className="page-head rise rise-1" style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20 }}>
          <div>
            <h1 className="page-title">Connectors</h1>
            <p className="page-sub">
              A connector is a target site plus its flows and auth — the unit that extends Portico to a new portal.
              Deployments of the same framework share self-heals.
            </p>
          </div>
          <Link href="/connectors/new" className="btn btn-primary" style={{ flex: "none", marginTop: 4 }}>
            <IconPlus className="ico-sm" /> New connector
          </Link>
        </div>

        <div className="section-head" style={{ marginTop: 8 }}>
          <h2>Your connectors</h2>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{dbConnectors.length} editable</span>
        </div>

        {dbConnectors.length === 0 ? (
          <div className="panel empty rise rise-2" style={{ padding: "44px 20px" }}>
            <div className="empty-t">No connectors yet</div>
            Create one with <b>New connector</b> to define its target, auth and variables.
          </div>
        ) : (
          <div className="stack rise rise-2" style={{ gap: 16 }}>
            {dbConnectors.map((c) => {
              const varCount = Object.keys(c.variables ?? {}).length;
              return (
                <div key={c.id} className="connector">
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                    <div>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 560, letterSpacing: "-0.02em" }}>{c.name}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.key}</span>
                        {c.framework && <span className="chip">{c.framework}</span>}
                        {varCount > 0 && <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{varCount} variable{varCount === 1 ? "" : "s"}</span>}
                      </div>
                      {c.baseUrl && <div className="mono" style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>{c.baseUrl}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>
                      <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>updated {fmtRelative(c.updatedAt)}</span>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Link href={`/flows/new?connector=${encodeURIComponent(c.key)}`} className="btn" style={{ padding: "6px 11px", fontSize: 12 }}>
                          <IconPlus className="ico-sm" /> New flow
                        </Link>
                        <ConnectorActions id={c.id} editKey={c.key} name={c.name} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {seedConnectors.length > 0 && (
          <>
            <div className="section-head">
              <h2>Seed connectors</h2>
              <span className="chip">read-only</span>
            </div>
            <div className="stack rise rise-3" style={{ gap: 16 }}>
              {seedConnectors.map((c) => (
                <div key={c.key} className="connector" style={{ opacity: 0.92 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                    <div>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 560, letterSpacing: "-0.02em" }}>{c.name}</div>
                      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
                        <span className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.key}</span>
                        {c.framework && <span className="chip">{c.framework}</span>}
                        <span className="chip" style={{ color: "var(--ink-3)" }}>seed</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{c.flows.length} flow{c.flows.length === 1 ? "" : "s"}</span>
                      <Link href={`/flows/new?connector=${encodeURIComponent(c.key)}`} className="btn" style={{ padding: "6px 11px", fontSize: 12 }}>
                        <IconPlus className="ico-sm" /> New flow
                      </Link>
                    </div>
                  </div>

                  {c.instances.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div className="eyebrow" style={{ marginBottom: 8 }}>Instances · deployments this connector runs against</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                        {c.instances.map((inst) => (
                          <div
                            key={inst.name}
                            title={inst.baseUrl ?? inst.host ?? ""}
                            style={{
                              display: "flex", alignItems: "center", gap: 8, padding: "6px 11px",
                              border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", background: "var(--paper)",
                            }}
                          >
                            <span className="mono" style={{ fontSize: 12.5, color: "var(--ink-2)", fontWeight: 600 }}>{inst.name}</span>
                            {inst.host && <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{inst.host}</span>}
                            {inst.local && <span className="chip" style={{ fontSize: 10.5 }}>local</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {c.flows.length > 0 && (
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
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 14, color: "var(--ink-3)", fontSize: 13 }}>
          Try the engine end-to-end with no credentials: <RunButton label="Run smoke flow" className="btn" />
        </div>
      </div>
    </>
  );
}
