"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconTrash } from "./icons";

type Note = { kind: "ok" | "error"; text: string } | null;

/** Two-step inline delete for a flow version. First click swaps the button for
 *  a compact confirm row ("This version" / "All versions") — no window.confirm.
 *  On success it refreshes the list, or navigates back to /flows when the
 *  deleted flow's own detail page is showing (onDone="detail"). All handlers
 *  stopPropagation so the button never triggers row-link navigation. */
export function FlowDeleteButton({
  flowId,
  flowKey,
  versions,
  onDone = "list",
}: {
  flowId: string;
  flowKey: string;
  versions?: number;
  onDone?: "list" | "detail";
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  const danger = { color: "var(--fail)", borderColor: "var(--fail)" } as const;

  async function doDelete(e: React.MouseEvent, allVersions: boolean) {
    e.stopPropagation();
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/flows/${flowId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allVersions }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Delete failed") });
        return;
      }
      if (onDone === "detail") router.push("/flows");
      else router.refresh();
    } catch (err) {
      setNote({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", flexDirection: "column", gap: 6 }}>
      {!confirming ? (
        <button
          className="btn"
          style={danger}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            setNote(null);
            setConfirming(true);
          }}
        >
          <IconTrash className="ico-sm" /> Delete
        </button>
      ) : (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>Delete {flowKey}?</span>
          <button className="btn" style={danger} disabled={busy} onClick={(e) => doDelete(e, false)}>
            {busy ? "Deleting…" : "This version"}
          </button>
          {(versions ?? 1) > 1 && (
            <button className="btn" style={danger} disabled={busy} onClick={(e) => doDelete(e, true)}>
              All {versions} versions
            </button>
          )}
          <button
            className="btn"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        </span>
      )}

      {note && (
        <span
          style={{
            padding: "6px 10px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12,
            border: "1px solid",
            borderColor: "oklch(0.86 0.05 27)",
            background: "var(--fail-wash)",
            color: "var(--fail)",
          }}
        >
          {note.text}
        </span>
      )}
    </span>
  );
}
