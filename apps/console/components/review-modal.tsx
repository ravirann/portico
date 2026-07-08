"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { parse, stringify } from "yaml";

export interface ReviewStep {
  /** Position in the flow's `steps` array — used to rewrite the YAML in place. */
  index: number;
  label: string;
  type: string;
  detail?: string;
  /**
   * For act steps that click a literal element: the semantic locator's name/role
   * plus the compiler's param_hint suggestion (when the name looks like a value
   * from THIS demonstration — a patient name, phone/claim number). Enables the
   * review-time "Use as input" parameterization below.
   */
  act?: { name: string; role?: string; suggest?: string };
}

type ValState = { passed: boolean; reasons: string[] } | null;

/** Input names must survive the engine's `{{[\w.]+}}` template grammar (no hyphens). */
function sanitizeInputName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Minimal shape of the parsed flow YAML we rewrite; everything else passes through. */
interface FlowDoc {
  inputs?: Record<string, string>;
  steps?: Array<{ locator?: { semantic?: { name?: string; param_hint?: string } } }>;
  [k: string]: unknown;
}

/**
 * Post-compile verification. Shown on a freshly recorded/compiled draft
 * (?review=1): review the captured steps, optionally parameterize
 * demonstration-specific literals into flow inputs (saved as the next draft
 * version), then run the validation harness (a real dry-run that must produce
 * the expected outputs) and confirm — all in one guided pass instead of
 * leaving the user on a static page.
 */
export function ReviewModal({
  flowId,
  flowKey,
  connector,
  yaml,
  steps,
  outputs,
  guarded,
}: {
  flowId: string;
  flowKey: string;
  connector?: string;
  yaml: string;
  steps: ReviewStep[];
  outputs: string[];
  guarded: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState<"validate" | "confirm" | "apply" | null>(null);
  const [val, setVal] = useState<ValState>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Per-step parameterization: toggled on/off + the editable input name,
  // prefilled from the compiler's suggestion (or a slug of the clicked text).
  const [params, setParams] = useState<Record<number, { on: boolean; input: string }>>(() => {
    const init: Record<number, { on: boolean; input: string }> = {};
    for (const s of steps) {
      if (s.act) init[s.index] = { on: false, input: s.act.suggest ?? sanitizeInputName(s.act.name) };
    }
    return init;
  });
  const chosen = steps.filter((s) => s.act && params[s.index]?.on);

  if (!open) return null;

  function close() {
    setOpen(false);
    router.refresh();
  }

  async function validate() {
    setBusy("validate");
    setNote(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/validate`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Validation could not run.") });
        return;
      }
      setVal({ passed: Boolean(data.passed), reasons: Array.isArray(data.reasons) ? (data.reasons as string[]) : [] });
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  async function confirm() {
    setBusy("confirm");
    setNote(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/confirm`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Confirm failed.") });
        return;
      }
      close();
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Rewrite the YAML client-side — each toggled step's semantic name becomes
   * `{{<input>}}` (intent stays as documentation of the recorded literal) and
   * the input lands in the top-level `inputs:` map — then save it as the next
   * draft version and jump to its review pass.
   */
  async function applyInputs() {
    setBusy("apply");
    setNote(null);
    try {
      const doc = parse(yaml) as FlowDoc | null;
      if (!doc || !Array.isArray(doc.steps)) throw new Error("Could not parse the flow YAML to apply inputs.");
      const inputs: Record<string, string> = { ...(doc.inputs ?? {}) };
      for (const s of chosen) {
        const inputName = sanitizeInputName(params[s.index]!.input);
        if (!inputName) throw new Error(`Step ${s.index + 1}: input name must contain letters or numbers.`);
        const sem = doc.steps[s.index]?.locator?.semantic;
        if (!sem || typeof sem.name !== "string") {
          throw new Error(`Step ${s.index + 1} has no semantic locator name to parameterize.`);
        }
        inputs[inputName] = `string — e.g. ${sem.name}`;
        sem.name = `{{${inputName}}}`;
        delete sem.param_hint; // applied — don't re-suggest on the next review pass
      }
      doc.inputs = inputs;

      const res = await fetch(`/api/flows/${flowId}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: flowKey, yaml: stringify(doc), connector }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error || !data.id) {
        setNote({ kind: "error", text: String(data.error ?? "Saving the parameterized draft failed.") });
        return;
      }
      router.push(`/flows/${String(data.id)}?review=1`);
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Verify the recorded flow" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">Verify recorded flow</div>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 560, marginTop: 4 }}>
              {steps.length} step{steps.length === 1 ? "" : "s"} captured
            </h2>
          </div>
          <button className="modal-x" onClick={close} aria-label="Close">✕</button>
        </div>

        <p style={{ color: "var(--ink-2)", fontSize: 13, lineHeight: 1.55 }}>
          Portico compiled your demonstration into these steps. Confirm they look right, then run the
          validation harness — a real dry-run that has to produce the expected data before the flow can go live.
        </p>

        {guarded && (
          <div className="review-guard">
            <b>Read-only</b> — guarded with <code className="mono">no_booking</code>; this flow can harvest data but never submits or books.
          </div>
        )}

        <ol className="review-steps">
          {steps.map((s, i) => {
            const p = s.act ? params[s.index] : undefined;
            return (
              <li key={i}>
                <span className="review-n">{i + 1}</span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="review-label">{s.label}</div>
                  <div className="review-type mono">{s.type}{s.detail ? ` · ${s.detail}` : ""}</div>
                  {s.act && p && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-2)", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={p.on}
                          disabled={busy !== null}
                          onChange={(e) => setParams((prev) => ({ ...prev, [s.index]: { ...p, on: e.target.checked } }))}
                        />
                        Use as input
                      </label>
                      {s.act.suggest && !p.on && (
                        <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
                          suggested — looks specific to this demonstration
                        </span>
                      )}
                      {p.on && (
                        <input
                          className="mono"
                          aria-label={`Input name for step ${s.index + 1}`}
                          value={p.input}
                          disabled={busy !== null}
                          onChange={(e) => setParams((prev) => ({ ...prev, [s.index]: { ...p, input: e.target.value } }))}
                          style={{
                            fontSize: 12,
                            padding: "3px 8px",
                            border: "1px solid var(--line, #ccc)",
                            borderRadius: 6,
                            background: "transparent",
                            color: "inherit",
                            minWidth: 180,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {steps.some((s) => s.act) && (
          <p style={{ color: "var(--ink-3)", fontSize: 12, lineHeight: 1.5, marginTop: 2 }}>
            Values captured from your demonstration can become inputs so the flow works for any
            patient/claim, not just this one.
          </p>
        )}

        {outputs.length > 0 && (
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 4 }}>
            Expected outputs:{" "}
            {outputs.map((o) => (
              <code key={o} className="mono" style={{ marginRight: 6, color: "var(--accent)" }}>{o}</code>
            ))}
          </div>
        )}

        {val && (
          <div className={`review-result ${val.passed ? "ok" : "bad"}`}>
            <div style={{ fontWeight: 700, marginBottom: val.reasons.length ? 6 : 0 }}>
              {val.passed ? "✓ Validation passed" : "✗ Validation failed"}
            </div>
            {val.reasons.length > 0 && (
              <ul style={{ listStyle: "none", display: "grid", gap: 4 }}>
                {val.reasons.map((r, i) => (
                  <li key={i} style={{ fontSize: 12.5 }}>{val.passed ? "✓" : "✗"} {r}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {note && (
          <div
            className="review-result bad"
            style={{ background: "var(--fail-wash)", borderColor: "oklch(0.86 0.05 27)", color: "var(--fail)" }}
          >
            {note.text}
          </div>
        )}

        <div className="modal-foot">
          {chosen.length > 0 && (
            <button className="btn btn-primary" onClick={applyInputs} disabled={busy !== null}>
              {busy === "apply" ? "Applying…" : `Apply input${chosen.length === 1 ? "" : "s"} (${chosen.length})`}
            </button>
          )}
          <button className="btn" onClick={validate} disabled={busy !== null}>
            {busy === "validate" ? "Validating…" : val ? "Re-validate" : "Validate"}
          </button>
          <button className="btn btn-primary" onClick={confirm} disabled={busy !== null || !val?.passed} title={!val?.passed ? "Validate first" : "Confirm for live execution"}>
            {busy === "confirm" ? "Confirming…" : "Confirm for live"}
          </button>
          <button className="btn" onClick={close} disabled={busy !== null} style={{ marginLeft: "auto" }}>
            Review on page
          </button>
        </div>
      </div>
    </div>
  );
}
