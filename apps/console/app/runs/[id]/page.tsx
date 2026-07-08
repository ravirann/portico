import Link from "next/link";
import { notFound } from "next/navigation";
import { getRun } from "@/lib/store";
import { fmtDuration, fmtRelative, tierLabel } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function RunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) notFound();

  return (
    <>
      <div className="topbar">
        <div className="crumb"><Link href="/runs">Runs</Link> <span>/</span> <b className="mono">{run.id}</b></div>
        <span className={`badge ${run.status}`}><span className="d" />{run.status}</span>
      </div>

      <div className="content">
        <div className="page-head rise rise-1">
          <div className="eyebrow" style={{ marginBottom: 10 }}>{run.connector}</div>
          <h1 className="page-title" style={{ fontSize: 30 }}>{run.flow}</h1>
        </div>

        <div className="grid-2 rise rise-2" style={{ alignItems: "start" }}>
          <div className="panel" style={{ padding: "8px 22px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0 4px" }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 560 }}>Step timeline</h2>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{run.steps.length} steps · {fmtDuration(run.durationMs)}</span>
            </div>
            <hr className="hairline" style={{ margin: "6px 0 8px" }} />
            <div className="timeline">
              {run.steps.map((s) => (
                <div key={s.index} className={`step ${s.status}`}>
                  <div className="step-dot">{s.status === "failed" ? "!" : s.status === "healed" ? "↻" : s.index + 1}</div>
                  <div className="step-body">
                    <div className="step-label">{s.label ?? s.type}</div>
                    <div className="step-type">{s.type}{s.status === "healed" ? " · self-healed" : ""}</div>
                    {s.detail && <div className="step-detail">{s.detail}</div>}
                  </div>
                  <div className="step-dur">{fmtDuration(s.durationMs)}</div>
                </div>
              ))}
            </div>

            {run.failure && (
              <div style={{ marginTop: 8, padding: "14px 16px", background: "var(--fail-wash)", border: "1px solid oklch(0.86 0.05 27)", borderRadius: "var(--radius-sm)" }}>
                <div style={{ fontWeight: 700, color: "var(--fail)", fontSize: 12.5, marginBottom: 5 }}>Failed at step {run.failure.stepIndex + 1} · fail-safe</div>
                <div style={{ fontSize: 13, color: "var(--ink-2)" }}>{run.failure.reason}</div>
              </div>
            )}
          </div>

          <div className="stack" style={{ gap: 20 }}>
            <div className="panel" style={{ padding: "18px 22px" }}>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Run</div>
              <dl className="kv">
                <dt>Engine</dt><dd>{run.engine}</dd>
                <dt>Tier</dt><dd><span className="chip">{tierLabel[run.tier]}</span></dd>
                <dt>Mode</dt><dd>{run.mode}</dd>
                <dt>Duration</dt><dd className="tnum">{fmtDuration(run.durationMs)}</dd>
                <dt>Started</dt><dd>{fmtRelative(run.startedAt)}</dd>
              </dl>
            </div>

            {run.output && Object.keys(run.output).length > 0 && (
              <div className="panel" style={{ padding: "18px 22px" }}>
                <div className="eyebrow" style={{ marginBottom: 12 }}>Structured output</div>
                <pre className="code">{JSON.stringify(run.output, null, 2)}</pre>
              </div>
            )}

            {(run.status === "failed" || run.status === "paused") && (
              <button className="btn" style={{ justifyContent: "center" }}>Resume from step {(run.failure?.stepIndex ?? 0) + 1}</button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
