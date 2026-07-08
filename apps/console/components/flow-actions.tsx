"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Action = "refine" | "validate" | "confirm";
type Note = { kind: "ok" | "error"; text: string } | null;

/** Draft controls for the flow detail page. Server-rendered page stays static;
 *  this island POSTs to the /api/flows/[id]/* route handlers and refreshes. */
export function FlowActions({ flowId }: { flowId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);
  const [note, setNote] = useState<Note>(null);

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
        setNote(
          data.passed
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
        <button className="btn btn-primary" onClick={() => run("confirm")} disabled={busy !== null}>
          {busy === "confirm" ? "Confirming…" : "Confirm"}
        </button>
        <button className="btn" onClick={() => run("validate")} disabled={busy !== null}>
          {busy === "validate" ? "Validating…" : "Validate"}
        </button>
        <button className="btn" onClick={() => run("refine")} disabled={busy !== null}>
          {busy === "refine" ? "Refining…" : "Refine"}
        </button>
      </div>

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
