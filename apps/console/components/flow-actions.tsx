"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FlowDeleteButton } from "./flow-delete-button";

type Action = "refine" | "validate" | "confirm";
type Note = { kind: "ok" | "error"; text: string } | null;

/** Draft controls for the flow detail page. Server-rendered page stays static;
 *  this island POSTs to the /api/flows/[id]/* route handlers and refreshes.
 *  `validated` (from the latest passing validation) drives the button state so a
 *  flow that's already validated shows "Re-validate" instead of prompting a
 *  fresh "Validate", and surfaces Confirm as the primary next step. */
export function FlowActions({ flowId, validated: validatedProp }: { flowId: string; validated: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [note, setNote] = useState<Note>(null);
  // Mirror the server's validation verdict locally so the button flips the
  // instant a validate completes, then stays in sync when the page refreshes.
  const [validated, setValidated] = useState(validatedProp);
  useEffect(() => setValidated(validatedProp), [validatedProp]);
  // The page only hands us the id; resolve the human-readable key for the
  // delete confirm label via the flow read API (falls back to the id).
  const [flowKey, setFlowKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/flows/${flowId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f: { key?: string } | null) => {
        if (!cancelled && typeof f?.key === "string") setFlowKey(f.key);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  async function run(action: Action) {
    setBusy(action);
    setNote(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/${action}`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? `${action} failed`) });
        return;
      }

      if (action === "refine" && typeof data.id === "string" && data.id !== flowId) {
        router.push(`/flows/${data.id}`);
        return;
      }
      if (action === "validate") {
        const passed = Boolean(data.passed);
        setValidated(passed);
        setNote(
          passed
            ? { kind: "ok", text: "Validation passed ✓" }
            : { kind: "error", text: "Validation failed — see reasons below." },
        );
      } else if (action === "confirm") {
        setNote({ kind: "ok", text: "Flow confirmed for live execution." });
      }
      router.refresh();
    } catch (err) {
      setNote({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className={validated ? "btn btn-primary" : "btn"}
          onClick={() => run("confirm")}
          disabled={busy !== null || !validated}
          title={validated ? "Confirm for live execution" : "Validate the flow before confirming"}
        >
          {busy === "confirm" ? "Confirming…" : "Confirm"}
        </button>
        <button
          className={validated ? "btn" : "btn btn-primary"}
          onClick={() => run("validate")}
          disabled={busy !== null}
          title={validated ? "Already validated — run again only if the flow changed" : "Dry-run against a live session"}
        >
          {busy === "validate" ? "Validating…" : validated ? "Re-validate" : "Validate"}
        </button>
        <button className="btn" onClick={() => run("refine")} disabled={busy !== null}>
          {busy === "refine" ? "Refining…" : "Refine"}
        </button>
        <FlowDeleteButton flowId={flowId} flowKey={flowKey ?? flowId} onDone="detail" />
      </div>

      {validated && !note && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--ok)", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontWeight: 700 }}>✓</span> Validated — ready to confirm. No need to re-validate unless you edit the flow.
        </div>
      )}

      {note && (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            border: "1px solid",
            borderColor: note.kind === "error" ? "oklch(0.86 0.05 27)" : "var(--accent-line)",
            background: note.kind === "error" ? "var(--fail-wash)" : "var(--accent-wash)",
            color: note.kind === "error" ? "var(--fail)" : "var(--accent)",
          }}
        >
          {note.text}
        </div>
      )}
    </div>
  );
}
