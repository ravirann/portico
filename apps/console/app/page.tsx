import Link from "next/link";
import { listRuns } from "@/lib/store";
import { listConnectors } from "@/lib/connectors";
import { fmtDuration, fmtRelative, tierLabel } from "@/lib/format";
import { RunButton } from "@/components/run-button";
import { IconArrow, IconBolt, IconShield } from "@/components/icons";

export const dynamic = "force-dynamic";

const LOOP: { n: string; title: string; body: string; href: string; cta: string }[] = [
  { n: "01", title: "Record", body: "Drive a portal once — log in and do the task. Portico captures the clicks and the traffic.", href: "/flows", cta: "Flows" },
  { n: "02", title: "Compile", body: "That recording becomes a draft flow automatically — navigate, harvest, select. No YAML by hand.", href: "/flows", cta: "Drafts" },
  { n: "03", title: "Validate", body: "Dry-run the draft against a live session. It has to produce real data before it can ship.", href: "/sessions", cta: "Sessions" },
  { n: "04", title: "Confirm", body: "Promote the validated flow. From here it replays on demand — at browser speed, no model in the loop.", href: "/flows", cta: "Confirm" },
];

export default function Dashboard() {
  const runs = listRuns();
  const connectors = listConnectors();
  const completed = runs.filter((r) => r.status === "completed");
  const successRate = runs.length ? Math.round((completed.length / runs.length) * 100) : 0;
  const flowCount = connectors.reduce((n, c) => n + c.flows.length, 0);
  const healed = runs.reduce((n, r) => n + r.steps.filter((s) => s.status === "healed").length, 0);

  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Overview</b></div>
        <RunButton label="Run smoke flow" />
      </div>

      <div className="content">
        <div className="page-head rise rise-1">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Self-serve browser automation</div>
          <h1 className="page-title">Record a portal once. Replay it in seconds.</h1>
          <p className="page-sub">
            Portico turns a recorded click-through into a validated, self-hosted automation — harvesting the
            portal&rsquo;s own data instead of scraping it, with no model on the hot path. Even portals you don&rsquo;t control.
          </p>
        </div>

        <div className="metrics rise rise-2">
          <Metric k="Runs" v={String(runs.length)} foot={<span><span className="up">{successRate}%</span> completed</span>} />
          <Metric k="Success rate" v={<><span className="tnum">{successRate}</span><small>%</small></>} foot={<span>{completed.length}/{runs.length} runs</span>} />
          <Metric k="Connectors" v={String(connectors.length)} foot={<span>{flowCount} flows</span>} />
          <Metric k="Self-heals" v={String(healed)} foot={<span>locators recovered</span>} />
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
              {runs.length === 0 ? (
                <div style={{ padding: "40px 24px", textAlign: "center", color: "var(--ink-3)", fontSize: 13.5 }}>
                  No runs yet. Record a workflow and validate a draft to see runs here.
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr><th>Flow</th><th>Tier</th><th>Status</th><th>Duration</th><th style={{ textAlign: "right" }}>When</th></tr>
                  </thead>
                  <tbody>
                    {runs.slice(0, 6).map((r) => (
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
              )}
            </div>
          </div>

          <div className="rise rise-4 stack" style={{ gap: 20 }}>
            <div className="panel" style={{ padding: "22px 22px" }}>
              <div className="eyebrow" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <IconBolt className="ico-sm" /> The self-serve loop
              </div>
              <ol className="loop">
                {LOOP.map((s) => (
                  <li key={s.n}>
                    <span className="loop-n">{s.n}</span>
                    <div className="loop-body">
                      <div className="loop-title">
                        {s.title}
                        <Link href={s.href} className="loop-cta">{s.cta} <IconArrow className="ico-sm" /></Link>
                      </div>
                      <p>{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="panel trust" style={{ padding: "16px 22px" }}>
              <IconShield className="ico-sm" />
              <span>Self-hosted — credentials never leave your infrastructure. Secrets vaulted &amp; redacted from every trace; egress firewalled to allowed domains.</span>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .loop { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 4px; }
        .loop li { display: grid; grid-template-columns: auto 1fr; gap: 14px; padding: 12px 0; position: relative; }
        .loop li:not(:last-child) { border-bottom: 1px solid var(--line); }
        .loop-n { font-family: var(--font-mono, ui-monospace); font-size: 12px; color: var(--accent); font-weight: 600; padding-top: 2px; letter-spacing: 0.04em; }
        .loop-title { display: flex; align-items: center; justify-content: space-between; font-weight: 650; font-size: 14.5px; }
        .loop-cta { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--ink-3); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
        .loop-cta:hover { color: var(--accent); }
        .loop-body p { color: var(--ink-2); font-size: 13px; margin: 5px 0 0; line-height: 1.5; max-width: 46ch; }
        .trust { display: flex; align-items: flex-start; gap: 11px; color: var(--ink-2); font-size: 12.5px; line-height: 1.5; }
        .trust svg { margin-top: 2px; flex: none; color: var(--accent); }
      `}</style>
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
