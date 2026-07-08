"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

/** Global LLM configuration form. Secrets are write-only: the stored API key is
 *  never rendered — we show only configured/not-set and take a NEW value (blank
 *  keeps the existing one). */
export function SettingsForm({
  initial,
}: {
  initial: { provider: string; model: string; apiKeyConfigured: boolean };
}) {
  const router = useRouter();
  const [provider, setProvider] = useState(initial.provider || "anthropic");
  const [model, setModel] = useState(initial.model);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setNote(null);
    try {
      const entries = [
        { scope: "global", category: "llm" as const, key: "provider", value: provider },
        { scope: "global", category: "llm" as const, key: "model", value: model },
        { scope: "global", category: "llm" as const, key: "api_key", value: apiKey, secret: true },
      ];
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Save failed") });
        return;
      }
      setApiKey("");
      setNote({ kind: "ok", text: "Settings saved." });
      router.refresh();
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ padding: "22px 24px", maxWidth: 560 }}>
      <div className="eyebrow" style={{ marginBottom: 18 }}>Global LLM</div>
      <div className="stack" style={{ gap: 16 }}>
        <div>
          <label style={labelStyle}>Provider</label>
          <select style={fieldStyle} value={provider} onChange={(e) => setProvider(e.target.value)}>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
          </select>
        </div>
        <div>
          <label style={labelStyle}>Model</label>
          <input style={fieldStyle} className="mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-…" />
        </div>
        <div>
          <label style={labelStyle}>
            API key{" "}
            <span style={{ color: initial.apiKeyConfigured ? "var(--ok)" : "var(--ink-3)", fontWeight: 700 }}>
              {initial.apiKeyConfigured ? "· configured ✓" : "· not set"}
            </span>
          </label>
          <input
            style={fieldStyle}
            className="mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initial.apiKeyConfigured ? "leave blank to keep existing" : "sk-…"}
          />
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
            Stored as a secret. The saved value is never shown here.
          </div>
        </div>
      </div>

      {note && (
        <div
          style={{
            marginTop: 16,
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

      <div style={{ marginTop: 18 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
