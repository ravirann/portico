"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { YamlEditor } from "./yaml-editor";
import { IconPlus } from "./icons";

export interface ConnectorOption {
  key: string;
  name: string;
  /** false for read-only filesystem "seed" connectors. */
  editable: boolean;
}

/** Starter flow, seeded with the chosen key. Read-only by default (no_booking)
 *  and referencing {{base_url}} — which the connector's instance resolves at run
 *  time — so a new draft is valid and safe the moment it's created. */
function starterYaml(key: string): string {
  const k = key || "my-flow";
  return `key: ${k}
version: 1
description: What this flow reads or does. Keep it read-only unless you mean to write.

# Values the caller supplies at run time (name: type). Reference as {{name}}.
inputs: {}

# Safety rails. no_booking keeps the flow discovery-only — it never submits.
guard:
  no_booking: true

steps:
  - type: navigate
    label: Open the starting page
    url: "{{base_url}}/"

  # Epic-style 2FA can't be scripted — pause for a human, then drive the rest.
  - type: human
    label: Log in if the portal requires it, then press Enter.
`;
}

// Must start AND end alphanumeric; hyphens/underscores allowed inside. Keep in
// sync with the server-side KEY_RE in /api/flows.
const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
// While TYPING we only normalize (lowercase, spaces → "-", drop invalid chars);
// we must NOT strip leading/trailing separators here or a just-typed hyphen
// vanishes and "book-appointment" becomes untypeable. KEY_RE handles validity.
const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");

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

/** Author a brand-new flow: pick the connector it targets, name it, edit the
 *  seeded YAML, and create a version-1 draft (persisted in the DB). On success,
 *  navigates to the new flow's detail page to validate → confirm. */
export function NewFlowEditor({
  connectors,
  initialConnector,
}: {
  connectors: ConnectorOption[];
  initialConnector?: string;
}) {
  const router = useRouter();
  const [connector, setConnector] = useState(initialConnector ?? "");
  const [key, setKey] = useState("");
  // The YAML the user has actually touched; null until they edit, so the seeded
  // template keeps tracking the key field until then.
  const [editedYaml, setEditedYaml] = useState<string | null>(null);
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const seeded = useMemo(() => starterYaml(key), [key]);
  const yamlText = editedYaml ?? seeded;
  const keyValid = KEY_RE.test(key);

  async function create() {
    if (!keyValid) {
      setNote({ kind: "error", text: "Enter a key: lowercase letters, numbers, hyphens or underscores; start and end with a letter or number." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, yaml: yamlText, connector: connector || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Could not create the flow.") });
        return;
      }
      if (typeof data.id === "string") {
        router.push(`/flows/${data.id}`);
        router.refresh();
        return;
      }
      setNote({ kind: "ok", text: "Created." });
      router.refresh();
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="panel" style={{ padding: "20px 22px" }}>
        <div className="eyebrow" style={{ marginBottom: 16 }}>Details</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>Connector</label>
            <select style={fieldStyle} value={connector} onChange={(e) => setConnector(e.target.value)}>
              <option value="">— unassigned —</option>
              {connectors.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name} ({c.key}){c.editable ? "" : " · seed"}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
              The flow runs against this connector&apos;s instances. Pick the instance at run time.
            </div>
          </div>
          <div>
            <label style={labelStyle}>Flow key</label>
            <input
              style={fieldStyle}
              className="mono"
              value={key}
              onChange={(e) => setKey(slugify(e.target.value))}
              placeholder="book-appointment"
            />
            <div style={{ fontSize: 11, color: key && !keyValid ? "var(--fail)" : "var(--ink-3)", marginTop: 4 }}>
              Lowercase letters, numbers, hyphens or underscores; start and end with a letter or number. Becomes the flow&apos;s identity across versions.
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div className="eyebrow">Flow YAML</div>
          <span style={{ fontSize: 12, color: "var(--ink-3)" }}>
            {editedYaml === null ? "seeded template — edits track the key until you type" : "creates version 1 (draft)"}
          </span>
        </div>

        <YamlEditor
          value={yamlText}
          onChange={setEditedYaml}
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

        <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center" }}>
          <button className="btn btn-primary" onClick={create} disabled={busy || !valid || !keyValid}>
            <IconPlus className="ico-sm" /> {busy ? "Creating…" : "Create draft"}
          </button>
          <button className="btn" onClick={() => router.push("/flows")} disabled={busy}>
            Cancel
          </button>
          {!valid && <span style={{ fontSize: 12, color: "var(--fail)" }}>Fix YAML errors before creating.</span>}
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.55 }}>
          A draft is saved and version-controlled in the store. From its page you&apos;ll{" "}
          <b style={{ color: "var(--ink-2)" }}>validate</b> (a dry run that must produce the expected data) and then{" "}
          <b style={{ color: "var(--ink-2)" }}>confirm</b> it for live execution.
        </div>
      </div>
    </div>
  );
}
