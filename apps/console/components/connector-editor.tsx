"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconTrash } from "./icons";

interface VariableRow {
  key: string;
  value: string;
}

export interface ConnectorEditorProps {
  /** Present when editing; absent when creating. */
  initial?: {
    key: string;
    name: string;
    framework?: string;
    baseUrl?: string;
    auth?: string;
    variables: Record<string, string>;
  };
  /** Per-connector LLM override state (values for non-secret keys; a flag for the key). */
  llm?: { provider?: string; model?: string; apiKeyConfigured?: boolean };
}

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

/** Create/edit form for a DB-backed connector. Posts the record, its variables
 *  and any per-connector LLM override in one request to /api/connectors. */
export function ConnectorEditor({ initial, llm }: ConnectorEditorProps) {
  const router = useRouter();
  const isEdit = Boolean(initial);

  const [key, setKey] = useState(initial?.key ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [framework, setFramework] = useState(initial?.framework ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [auth, setAuth] = useState(initial?.auth ?? "");
  const [vars, setVars] = useState<VariableRow[]>(
    Object.entries(initial?.variables ?? {}).map(([k, v]) => ({ key: k, value: v })),
  );

  const [provider, setProvider] = useState(llm?.provider ?? "");
  const [model, setModel] = useState(llm?.model ?? "");
  const [apiKey, setApiKey] = useState("");

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  function setVar(i: number, patch: Partial<VariableRow>) {
    setVars((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    if (!key.trim() || !name.trim()) {
      setNote({ kind: "error", text: "Key and name are required." });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/connectors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: key.trim(),
          name: name.trim(),
          framework: framework.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          auth: auth.trim() || undefined,
          variables: vars.filter((v) => v.key.trim()),
          llm:
            provider.trim() || model.trim() || apiKey.trim()
              ? { provider: provider.trim(), model: model.trim(), apiKey: apiKey.trim() }
              : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Save failed") });
        return;
      }
      router.push("/connectors");
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
            <label style={labelStyle}>Key</label>
            <input
              style={{ ...fieldStyle, ...(isEdit ? { opacity: 0.6, cursor: "not-allowed" } : {}) }}
              className="mono"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={isEdit}
              placeholder="acme-portal"
            />
            {isEdit && <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>Key is immutable once created.</div>}
          </div>
          <div>
            <label style={labelStyle}>Name</label>
            <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Portal" />
          </div>
          <div>
            <label style={labelStyle}>Framework</label>
            <input style={fieldStyle} className="mono" value={framework} onChange={(e) => setFramework(e.target.value)} placeholder="example-portal" />
          </div>
          <div>
            <label style={labelStyle}>Auth</label>
            <input style={fieldStyle} className="mono" value={auth} onChange={(e) => setAuth(e.target.value)} placeholder="portal-login" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Base URL</label>
            <input style={fieldStyle} className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://portal.example.com" />
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <div className="eyebrow">Variables</div>
          <button className="btn" style={{ padding: "5px 11px", fontSize: 12 }} onClick={() => setVars((r) => [...r, { key: "", value: "" }])}>
            <IconPlus className="ico-sm" /> Add
          </button>
        </div>
        {vars.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No variables. Add key/value pairs the flows can reference.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {vars.map((v, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "center" }}>
                <input style={fieldStyle} className="mono" placeholder="key" value={v.key} onChange={(e) => setVar(i, { key: e.target.value })} />
                <input style={fieldStyle} className="mono" placeholder="value" value={v.value} onChange={(e) => setVar(i, { value: e.target.value })} />
                <button
                  className="btn"
                  style={{ padding: "8px 10px" }}
                  onClick={() => setVars((rows) => rows.filter((_, idx) => idx !== i))}
                  aria-label="Remove variable"
                >
                  <IconTrash className="ico-sm" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel" style={{ padding: "20px 22px" }}>
        <div className="eyebrow" style={{ marginBottom: 6 }}>LLM override</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 16 }}>
          Optional. Overrides the global model for this connector&apos;s flows. Leave blank to inherit global settings.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>Provider</label>
            <select style={fieldStyle} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">— inherit —</option>
              <option value="anthropic">anthropic</option>
              <option value="openai">openai</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Model</label>
            <input style={fieldStyle} className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-…" />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>
              API key{" "}
              <span style={{ color: llm?.apiKeyConfigured ? "var(--ok)" : "var(--ink-3)", fontWeight: 700 }}>
                {llm?.apiKeyConfigured ? "· configured ✓" : "· not set"}
              </span>
            </label>
            <input style={fieldStyle} className="mono" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={llm?.apiKeyConfigured ? "leave blank to keep existing" : "sk-…"} />
          </div>
        </div>
      </div>

      {note && (
        <div
          style={{
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

      <div style={{ display: "flex", gap: 10 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : isEdit ? "Save changes" : "Create connector"}
        </button>
        <button className="btn" onClick={() => router.push("/connectors")} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
