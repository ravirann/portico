import Link from "next/link";
import { listRuns } from "@/lib/store";
import { listConnectors } from "@/lib/connectors";
import { fmtDuration, fmtRelative, tierLabel } from "@/lib/format";
import { RunButton } from "@/components/run-button";
import { IconArrow, IconBolt, IconShield } from "@/components/icons";

export const dynamic = "force-dynamic";

export default function Dashboard() {
  const runs = listRuns();
  const connectors = listConnectors();
  const completed = runs.filter((r) => r.status === "completed");
  const domRuns = completed.filter((r) => r.tier === "dom");
  const successRate = runs.length ? Math.round((completed.length / runs.length) * 100) : 0;
  const p50 = median(domRuns.map((r) => r.durationMs));
  const healed = runs.reduce((n, r) => n + r.steps.filter((s) => s.status === "healed").length, 0);

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Overview</b></div>
        <RunButton label="Run smoke flow" />
      </div>

      <div className="content">
        <div className="page-head rise rise-1">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Automation control</div>
          <h1 className="page-title">Every run, deterministic and accounted for.</h1>
          <p className="page-sub">
            Flows replay without a model in the loop, self-heal when a portal shifts, and leave a full
            audit trail — all self-hosted, so credentials never leave your infrastructure.
          </p>
        </div>

        <div className="metrics rise rise-2">
          <Metric k="Runs today" v={String(runs.length)} foot={<span><span className="up">{successRate}%</span> completed</span>} />
          <Metric k="DOM-tier p50" v={<><span className="tnum">{(p50 / 1000).toFixed(1)}</span><small>s</small></>} foot={<span>SLO &lt; 6.0s</span>} />
          <Metric k="Self-heals" v={String(healed)} foot={<span>locators recovered</span>} />
          <Metric k="Connectors" v={String(connectors.length)} foot={<span>{connectors.reduce((n, c) => n + c.flows.length, 0)} flows</span>} />
        </div>

        <div className="grid-2" style={{ marginTop: 40 }}>
          <div className="rise rise-3">
            <div className="section-head" style={{ margin: "0 0 14px" }}>
              <h2>Recent runs</h2>
              <Link href="/runs" className="nav-item" style={{ padding: "5px 8px", fontSize: 12.5 }}>
                All runs <IconArrow className="ico-sm" />
              </Link>
            </div>
            <div className="panel">
              <table className="table">
                <thead>
                  <tr><th>Flow</th><th>Tier</th><th>Status</th><th>Duration</th><th style={{ textAlign: "right" }}>When</th></tr>
                </thead>
                <tbody>
                  {runs.slice(0, 5).map((r) => (
                    <tr key={r.id} className="rowlink">
                      <td className="flowcell">
                        <Link href={`/runs/${r.id}`}>{r.flow}<small>{r.connector} · {r.id}</small></Link>
                      </td>
                      <td><span className="chip">{tierLabel[r.tier]}</span></td>
                      <td><StatusBadge status={r.status} /></td>
                      <td className="tnum">{fmtDuration(r.durationMs)}</td>
                      <td style={{ textAlign: "right", color: "var(--ink-3)" }}>{fmtRelative(r.startedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rise rise-4 stack" style={{ gap: 20 }}>
            <div className="panel" style={{ padding: "22px 22px" }}>
              <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <IconBolt className="ico-sm" /> Latency guarantee
              </div>
              <p style={{ fontFamily: "var(--font-display)", fontSize: 19, lineHeight: 1.35, marginTop: 14, letterSpacing: "-0.01em" }}>
                No model call sits on a promoted flow&rsquo;s hot path.
              </p>
              <p style={{ color: "var(--ink-2)", fontSize: 13, marginTop: 10 }}>
                AI authors and heals off the critical path. Steady-state latency is browser speed, not model speed — enforced in review.
              </p>
              <hr className="hairline" style={{ margin: "18px 0 14px" }} />
              <TierBar label="API tier" value="sub-second" pct={12} />
              <TierBar label="DOM tier" value="seconds" pct={48} />
              <TierBar label="Agent tier" value="authoring only" pct={100} muted />
            </div>

            <div className="panel" style={{ padding: "20px 22px" }}>
              <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <IconShield className="ico-sm" /> Posture
              </div>
              <ul style={{ listStyle: "none", marginTop: 14, display: "grid", gap: 11 }}>
                {["Secrets vaulted, redacted from every trace", "One ephemeral browser context per run", "Egress firewalled to allowed domains", "Self-hosted — data never leaves"].map((t) => (
                  <li key={t} style={{ display: "flex", gap: 10, fontSize: 13, color: "var(--ink-2)" }}>
                    <span className="pulse" style={{ marginTop: 5 }} /> {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Metric({ k, v, foot }: { k: string; v: React.ReactNode; foot: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      <div className="foot">{foot}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}><span className="d" />{status}</span>;
}

function TierBar({ label, value, pct, muted }: { label: string; value: string; pct: number; muted?: boolean }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ color: "var(--ink-3)" }}>{value}</span>
      </div>
      <div style={{ height: 5, borderRadius: 4, background: "var(--paper-3)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 4, background: muted ? "var(--line-2)" : "linear-gradient(90deg, var(--accent-2), var(--accent))" }} />
      </div>
    </div>
  );
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
