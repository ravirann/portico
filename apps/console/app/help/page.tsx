import Link from "next/link";
import { ConceptModel } from "@/components/concept-model";

const STEPS: { n: string; term: string; body: React.ReactNode }[] = [
  {
    n: "01",
    term: "Start a session",
    body: (
      <>
        Log in to the portal once. A <Link href="/sessions">session</Link> holds the live,
        authenticated context — cookies and tokens stay on your own infrastructure, never in a
        model&rsquo;s prompt. Everything after this reuses that session.
      </>
    ),
  },
  {
    n: "02",
    term: "Record a demonstration",
    body: (
      <>
        Drive the task by hand — Portico watches the clicks and the portal&rsquo;s own network
        traffic and compiles them into a draft <Link href="/flows/new">flow</Link>: navigate,
        harvest, select. No YAML written by hand, and no model on the hot path once it&rsquo;s
        compiled.
      </>
    ),
  },
  {
    n: "03",
    term: "Validate",
    body: (
      <>
        Dry-run the draft against a live session in a harness that must produce the expected data
        before the flow can advance. It reads the portal&rsquo;s own responses — read-only, with a
        no-booking guardrail — so a validation never mutates anything on the far side.
      </>
    ),
  },
  {
    n: "04",
    term: "Confirm for live",
    body: (
      <>
        Promote the validated version. From here the flow replays deterministically on demand — at
        browser speed against any <Link href="/connectors">connector</Link> instance, with a full
        audit trail on every run.
      </>
    ),
  },
];

export default function HelpPage() {
  return (
    <>
      <div className="topbar">
        <div className="crumb"><b>Help</b></div>
      </div>

      <div className="content">
        <div className="page-head rise rise-1">
          <div className="eyebrow" style={{ marginBottom: 12 }}>Help &amp; docs</div>
          <h1 className="page-title">How Portico works</h1>
          <p className="page-sub">
            The four nouns Portico is built from, and the self-serve loop that turns a recorded
            click-through into a validated, self-hosted automation.
          </p>
        </div>

        <div className="rise rise-2" style={{ marginTop: 8 }}>
          <ConceptModel />
        </div>

        <div className="panel rise rise-3" style={{ marginTop: 40, padding: "26px 26px" }}>
          <div className="eyebrow">The self-serve loop</div>
          <p className="page-sub" style={{ marginTop: 8, marginBottom: 4 }}>
            Record once, validate against real data, then confirm for live. No model runs on the hot
            path — a confirmed flow is deterministic replay.
          </p>
          <ol className="help-loop">
            {STEPS.map((s) => (
              <li key={s.n}>
                <span className="help-loop-n">{s.n}</span>
                <div className="help-loop-body">
                  <div className="help-loop-term">{s.term}</div>
                  <p>{s.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <style>{`
        .help-loop { list-style: none; margin: 18px 0 0; padding: 0; display: grid; gap: 4px; }
        .help-loop li { display: grid; grid-template-columns: auto 1fr; gap: 16px; padding: 16px 0; }
        .help-loop li:not(:last-child) { border-bottom: 1px solid var(--line); }
        .help-loop-n { font-family: var(--font-mono, ui-monospace); font-size: 12px; color: var(--accent); font-weight: 600; padding-top: 2px; letter-spacing: 0.04em; }
        .help-loop-term { font-weight: 650; font-size: 15px; }
        .help-loop-body p { color: var(--ink-2); font-size: 13.5px; margin: 6px 0 0; line-height: 1.6; max-width: 64ch; }
        .help-loop-body a { color: var(--accent); font-weight: 600; }
      `}</style>
    </>
  );
}
