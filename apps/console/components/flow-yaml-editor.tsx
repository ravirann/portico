"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { YamlEditor } from "./yaml-editor";
import { IconEdit } from "./icons";

/** "Edit YAML" affordance on the flow detail page. Opens the CodeMirror editor
 *  (flow mode) pre-filled with the flow's YAML; Save is disabled while invalid
 *  and POSTs to the save route, navigating to the new version on success. */
export function FlowYamlEditor({
  flowId,
  flowKey,
  connector,
  initialYaml,
}: {
  flowId: string;
  flowKey: string;
  connector?: string;
  initialYaml: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [yamlText, setYamlText] = useState(initialYaml);
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch(`/api/flows/${flowId}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: flowKey, yaml: yamlText, connector }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Save failed") });
        return;
      }
      if (typeof data.id === "string") {
        router.push(`/flows/${data.id}`);
        router.refresh();
        return;
      }
      setNote({ kind: "ok", text: "Saved." });
      router.refresh();
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        <IconEdit className="ico-sm" /> Edit YAML
      </button>
    );
  }

  return (
    <div className="panel" style={{ padding: "18px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div className="eyebrow">Edit flow YAML</div>
        <span style={{ fontSize: 12, color: "var(--ink-3)" }}>saving creates a new version</span>
      </div>

      <YamlEditor
        value={yamlText}
        onChange={setYamlText}
        onValidChange={(v) => setValid(v)}
        mode="flow"
        minHeight="360px"
      />

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

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy || !valid}>
          {busy ? "Saving…" : "Save new version"}
        </button>
        <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        {!valid && <span style={{ alignSelf: "center", fontSize: 12, color: "var(--fail)" }}>Fix errors before saving.</span>}
      </div>
    </div>
  );
}
