"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlay } from "./icons";

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "var(--font-body)",
  fontSize: 13.5,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-2)",
  marginBottom: 6,
};

export interface FlowInputField {
  name: string;
  hint: string;
}

/** Run a CONFIRMED flow from its detail page: collect the flow's declared
 *  inputs, choose dry-run vs live, POST /api/runs and jump to the run. The
 *  server picks the live browser session (connector-aware), so the panel only
 *  asks for what the flow itself declares. */
/** The example value embedded in a hint ("string — e.g. 9717352594" → "9717352594"). */
function exampleOf(hint: string): string {
  const m = /e\.g\.\s*(.+)$/i.exec(hint ?? "");
  return (m?.[1] ?? "").trim();
}

export function RunFlowButton({ flowId, inputs }: { flowId: string; inputs: FlowInputField[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Prefill each field with its declared example so a required value (e.g. the
  // new language of a write) is never accidentally sent empty.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((f) => [f.name, exampleOf(f.hint)])),
  );
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ flowId, inputs: values, live }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Run failed") });
        return;
      }
      if (typeof data.id === "string" && data.id) {
        router.push(`/runs/${data.id}`);
        return;
      }
      setNote({ kind: "ok", text: "Run started." });
      router.refresh();
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button className="btn btn-primary" onClick={() => setOpen(true)}>
          <IconPlay className="ico-sm" /> Run flow
        </button>
        {note && (
          <span style={{ fontSize: 12.5, color: note.kind === "error" ? "var(--fail)" : "var(--accent)" }}>{note.text}</span>
        )}
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: "20px 22px", maxWidth: 640 }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>Run this flow</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 16 }}>
        Executes in the live browser session for this flow&apos;s connector.
      </div>

      {inputs.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          {inputs.map((f) => (
            <div key={f.name}>
              <label style={labelStyle}>{f.name}</label>
              <input
                style={fieldStyle}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                placeholder={f.hint}
              />
            </div>
          ))}
        </div>
      )}

      <div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: live ? "var(--fail)" : "var(--ink-2)" }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live mode {live ? "— will apply changes to the portal" : ""}
        </label>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
          {live
            ? "Any update step (PUT/PATCH/POST) will be SENT to the portal."
            : "Dry run — reads only; update steps are SKIPPED, so nothing changes on the portal."}
        </div>
      </div>

      {note && (
        <div
          style={{
            marginTop: 14,
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

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <button className="btn btn-primary" onClick={start} disabled={busy}>
          {busy ? "Running…" : "Start run"}
        </button>
        <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
