import Link from "next/link";
import { notFound } from "next/navigation";
import { parse } from "yaml";
import type { Flow, Step } from "@portico/flow-spec";
import { readFlow } from "@/lib/store";
import { fmtRelative } from "@/lib/format";
import type { FlowView } from "@/lib/types";
import { FlowActions } from "@/components/flow-actions";
import { RunFlowButton } from "@/components/run-flow-button";
import { FlowYamlEditor } from "@/components/flow-yaml-editor";
import { ReviewModal } from "@/components/review-modal";

export const dynamic = "force-dynamic";

function statusBadge(status: FlowView["status"]) {
  return status === "confirmed"
    ? { cls: "completed", label: "confirmed" }
    : { cls: "paused", label: "draft" };
}

function validationBadge(v: FlowView["validation"]) {
  if (!v) return { cls: "paused", label: "not validated" };
  if (v.passed) return { cls: "completed", label: "validated ✓" };
  return { cls: "failed", label: "failed ✗" };
}

/** Best single-line summary of what a step does, drawn from its typed fields. */
function stepDetail(s: Step): string | undefined {
  if (s.url) return s.url;
  if (s.type === "subflow" && s.use) return `→ ${s.use}`;
  if (s.type === "extract" && s.extract) return `→ output.${s.extract.key}`;
  if (s.resolve) return `${s.resolve.input} → output.${s.resolve.as}`;
  if (s.read) return `→ output.${s.read.as}`;
  if (s.select) return `${s.select.policy} of output.${s.select.from} → output.${s.select.as}`;
  if (s.intercept) return `${s.intercept.url_contains} → output.${s.intercept.as}`;
  if (s.wait) return `await output.${s.wait.for}`;
  if (s.condition) return s.condition;
  const bits = [s.value, s.locator?.semantic.intent].filter(Boolean);
  return bits.length ? bits.join(" · ") : undefined;
}

/** Try to parse the flow YAML into a typed step graph; null if malformed. */
function parseFlow(yaml: string): Flow | null {
  try {
    const f = parse(yaml) as Flow;
    return f && Array.isArray(f.steps) ? f : null;
  } catch {
    return null;
  }
}

/** Output keys a validation run must populate — from intercept/select/extract steps. */
function expectedOutputs(flow: Flow | null): string[] {
  if (!flow) return [];
  const keys: string[] = [];
  for (const s of flow.steps) {
    if (s.intercept?.as) keys.push(s.intercept.as);
    if (s.select?.as) keys.push(s.select.as);
    if (s.type === "extract" && s.extract?.key) keys.push(s.extract.key);
  }
  return [...new Set(keys)];
}

export default async function FlowDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const { id } = await params;
  const { review } = await searchParams;
  const flow = readFlow(id);
  if (!flow) notFound();

  const s = statusBadge(flow.status);
  const v = validationBadge(flow.validation);
  const parsed = parseFlow(flow.yaml);
  const inputs = parsed?.inputs ? Object.entries(parsed.inputs) : [];
  const showReview = review === "1" && flow.status === "draft" && parsed != null;

  return (
    <>
      {showReview && parsed && (
        <ReviewModal
          flowId={flow.id}
          flowKey={flow.key}
          connector={flow.connector}
          yaml={flow.yaml}
          steps={parsed.steps.map((step, index) => {
            // Act steps clicking a literal (non-templated) element can be
            // parameterized at review time; pass the locator's name/role and
            // the compiler's instance-specific suggestion (param_hint).
            const sem = step.type === "act" ? step.locator?.semantic : undefined;
            const act =
              sem?.name && !sem.name.includes("{{")
                ? { name: sem.name, role: sem.role, suggest: sem.param_hint }
                : undefined;
            return {
              index,
              label: step.label ?? step.type,
              type: step.type,
              detail: stepDetail(step),
              act,
            };
          })}
          outputs={expectedOutputs(parsed)}
          guarded={Boolean(parsed.guard?.no_booking)}
        />
      )}
      <div className="topbar">
        <div className="crumb"><Link href="/flows">Flows</Link> <span>/</span> <b className="mono">{flow.key} v{flow.version}</b></div>
        <span className={`badge ${s.cls}`}><span className="d" />{s.label}</span>
      </div>

      <div className="content">
        <div className="page-head rise rise-1">
          <div className="eyebrow" style={{ marginBottom: 10 }}>{flow.connector ?? "unassigned connector"}</div>
          <h1 className="page-title" style={{ fontSize: 30 }}>{flow.key}</h1>
          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span className="chip">v{flow.version}</span>
            <span className="chip">{flow.source}</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>created {fmtRelative(flow.createdAt)}</span>
          </div>

          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            {flow.status === "draft" && <FlowActions flowId={flow.id} />}
            {flow.status === "confirmed" && (
              <RunFlowButton flowId={flow.id} inputs={inputs.map(([name, hint]) => ({ name, hint: String(hint) }))} />
            )}
            <FlowYamlEditor flowId={flow.id} flowKey={flow.key} connector={flow.connector} initialYaml={flow.yaml} />
          </div>
        </div>

        <div className="grid-2 rise rise-2" style={{ alignItems: "start" }}>
          <div className="panel" style={{ padding: "8px 22px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 0 4px" }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 560 }}>Flow steps</h2>
              {parsed && <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{parsed.steps.length} step{parsed.steps.length === 1 ? "" : "s"}</span>}
            </div>
            <hr className="hairline" style={{ margin: "6px 0 8px" }} />

            {parsed ? (
              <div className="timeline">
                {parsed.steps.map((step, i) => {
                  const detail = stepDetail(step);
                  return (
                    <div key={i} className="step ok">
                      <div className="step-dot">{i + 1}</div>
                      <div className="step-body">
                        <div className="step-label">{step.label ?? step.type}</div>
                        <div className="step-type">{step.type}</div>
                        {detail && <div className="step-detail mono">{detail}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <pre className="code" style={{ margin: "6px 0 12px" }}>{flow.yaml}</pre>
            )}
          </div>

          <div className="stack" style={{ gap: 20 }}>
            <div className="panel" style={{ padding: "18px 22px" }}>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Validation</div>
              <div style={{ marginBottom: flow.validation ? 14 : 0 }}>
                <span className={`badge ${v.cls}`}><span className="d" />{v.label}</span>
              </div>

              {flow.validation && flow.validation.reasons.length > 0 && (
                <ul style={{ listStyle: "none", display: "grid", gap: 8, marginTop: 4 }}>
                  {flow.validation.reasons.map((reason, i) => (
                    <li key={i} style={{ display: "flex", gap: 10, fontSize: 12.5, color: "var(--ink-2)" }}>
                      <span style={{ color: flow.validation!.passed ? "var(--ok)" : "var(--fail)", fontWeight: 700, lineHeight: 1.4 }}>
                        {flow.validation!.passed ? "✓" : "✗"}
                      </span>
                      {reason}
                    </li>
                  ))}
                </ul>
              )}

              {flow.validation?.runId && (
                <div style={{ marginTop: 14, fontSize: 12.5 }}>
                  <Link href={`/runs/${flow.validation.runId}`} style={{ color: "var(--accent)", fontWeight: 600 }}>
                    View validating run →
                  </Link>
                  <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{flow.validation.runId}</div>
                </div>
              )}

              {flow.validation && (
                <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 14 }}>
                  validated {fmtRelative(flow.validation.createdAt)}
                </div>
              )}
            </div>

            <div className="panel" style={{ padding: "18px 22px" }}>
              <div className="eyebrow" style={{ marginBottom: 12 }}>Draft</div>
              <dl className="kv">
                <dt>Key</dt><dd className="mono">{flow.key}</dd>
                <dt>Version</dt><dd className="mono">v{flow.version}</dd>
                <dt>Status</dt><dd><span className={`badge ${s.cls}`}><span className="d" />{s.label}</span></dd>
                <dt>Source</dt><dd><span className="chip">{flow.source}</span></dd>
                <dt>Connector</dt><dd>{flow.connector ?? "—"}</dd>
                <dt>Created</dt><dd>{fmtRelative(flow.createdAt)}</dd>
              </dl>
            </div>

            {inputs.length > 0 && (
              <div className="panel" style={{ padding: "18px 22px" }}>
                <div className="eyebrow" style={{ marginBottom: 12 }}>Inputs</div>
                <dl className="kv">
                  {inputs.map(([name, hint]) => (
                    <FragmentRow key={name} name={name} hint={String(hint)} />
                  ))}
                </dl>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function FragmentRow({ name, hint }: { name: string; hint: string }) {
  return (
    <>
      <dt className="mono">{name}</dt>
      <dd style={{ color: "var(--ink-2)" }}>{hint}</dd>
    </>
  );
}
