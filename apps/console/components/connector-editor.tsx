"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconTrash } from "./icons";

/** A variable row in the editor. `configured` marks a row that already exists in
 *  the store as a secret (its value came back masked, so blank means "keep"). */
interface VariableRow {
  key: string;
  value: string;
  secret: boolean;
  configured: boolean;
}

/** A stored variable as returned by /api/connectors/variables (secrets masked). */
export interface StoredVar {
  key: string;
  value: string;
  secret: boolean;
  configured: boolean;
}

const ENV_PRESETS = ["default", "dev", "staging", "prod"];

export interface ConnectorEditorProps {
  /** Present when editing; absent when creating. */
  initial?: {
    key: string;
    name: string;
    framework?: string;
    baseUrl?: string;
    auth?: string;
  };
  /** Variables for the default env, pre-loaded server-side to avoid a fetch flash. */
  initialVars?: StoredVar[];
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

function toRows(vars: StoredVar[] | undefined): VariableRow[] {
  return (vars ?? []).map((v) => ({ key: v.key, value: "", secret: v.secret, configured: v.configured }));
}

/** Create/edit form for a DB-backed connector. Posts the record + any
 *  per-connector LLM override to /api/connectors, and the current environment's
 *  variables (secret/regular, with deletes) to /api/connectors/variables. */
export function ConnectorEditor({ initial, initialVars, llm }: ConnectorEditorProps) {
  const router = useRouter();
  const isEdit = Boolean(initial);
  const connectorKey = initial?.key ?? "";

  const [key, setKey] = useState(initial?.key ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [framework, setFramework] = useState(initial?.framework ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [auth, setAuth] = useState(initial?.auth ?? "");

  // Variables are namespaced to `<connectorKey>:<env>`. Changing env reloads that
  // environment's stored variables (edit mode only — a new connector has none yet).
  const [env, setEnv] = useState("default");
  const [vars, setVars] = useState<VariableRow[]>(toRows(initialVars));
  const [removed, setRemoved] = useState<string[]>([]);
  const [loadingVars, setLoadingVars] = useState(false);
  const skipFirstFetch = useRef(true);

  const [provider, setProvider] = useState(llm?.provider ?? "");
  const [model, setModel] = useState(llm?.model ?? "");
  const [apiKey, setApiKey] = useState("");

  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Reload variables when the env changes. The default env is already seeded from
  // initialVars (server-rendered), so skip the very first run to avoid a flash.
  useEffect(() => {
    if (!isEdit || !connectorKey) return;
    if (skipFirstFetch.current && env === "default") {
      skipFirstFetch.current = false;
      return;
    }
    skipFirstFetch.current = false;
    let cancelled = false;
    setLoadingVars(true);
    setNote(null);
    fetch(`/api/connectors/variables?connector=${encodeURIComponent(connectorKey)}&env=${encodeURIComponent(env)}`)
      .then((r) => (r.ok ? r.json() : { variables: [] }))
      .then((d: { variables?: StoredVar[] }) => {
        if (cancelled) return;
        setVars(toRows(d.variables));
        setRemoved([]);
      })
      .catch(() => {
        if (!cancelled) setNote({ kind: "error", text: `Could not load ${env} variables.` });
      })
      .finally(() => {
        if (!cancelled) setLoadingVars(false);
      });
    return () => {
      cancelled = true;
    };
  }, [env, isEdit, connectorKey]);

  function setVar(i: number, patch: Partial<VariableRow>) {
    setVars((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  function removeVar(i: number) {
    setVars((rows) => {
      const row = rows[i];
      if (row?.configured && row.key.trim()) setRemoved((d) => [...d, row.key.trim()]);
      return rows.filter((_, idx) => idx !== i);
    });
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

      // Persist the current environment's variables (upserts + deletes). Blank
      // secret values are skipped server-side so existing keys are never clobbered.
      const varsRes = await fetch("/api/connectors/variables", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector: key.trim(),
          env,
          upserts: vars
            .filter((v) => v.key.trim())
            .map((v) => ({ key: v.key.trim(), value: v.value, secret: v.secret })),
          deletes: removed,
        }),
      });
      const varsData = (await varsRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!varsRes.ok || varsData.error) {
        setNote({ kind: "error", text: String(varsData.error ?? "Saved connector, but variables failed to save.") });
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 12, flexWrap: "wrap" }}>
          <div className="eyebrow">Variables</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Environment
            </label>
            <select
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              className="mono"
              style={{ ...fieldStyle, width: "auto", padding: "6px 10px", fontSize: 12.5, cursor: "pointer" }}
              aria-label="Variable environment"
            >
              {ENV_PRESETS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <button className="btn" style={{ padding: "5px 11px", fontSize: 12 }} onClick={() => setVars((r) => [...r, { key: "", value: "", secret: false, configured: false }])}>
              <IconPlus className="ico-sm" /> Add
            </button>
          </div>
        </div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 14, lineHeight: 1.5 }}>
          Variables are namespaced per connector <b>and</b> environment (scope <code className="mono">{(key.trim() || "<key>")}:{env}</code>).
          The same name never collides across connectors or between dev and prod. Reference them by bare name in this connector&apos;s flows.
          Secret values are write-only — a stored secret shows <b>configured ✓</b>; leave its value blank to keep it.
        </div>

        {loadingVars ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Loading {env} variables…</div>
        ) : vars.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>No variables in <b>{env}</b>. Add key/value pairs the flows can reference.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {vars.map((v, i) => (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 10, alignItems: "center" }}>
                <input style={fieldStyle} className="mono" placeholder="key" value={v.key} onChange={(e) => setVar(i, { key: e.target.value })} />
                <div style={{ position: "relative" }}>
                  <input
                    style={fieldStyle}
                    className="mono"
                    type={v.secret ? "password" : "text"}
                    placeholder={v.secret && v.configured ? "configured ✓ — blank keeps it" : v.secret ? "secret value" : "value"}
                    value={v.value}
                    onChange={(e) => setVar(i, { value: e.target.value })}
                    autoComplete="off"
                  />
                  {v.secret && v.configured && !v.value && (
                    <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, fontWeight: 700, color: "var(--ok)", pointerEvents: "none" }}>
                      configured ✓
                    </span>
                  )}
                </div>
                <label
                  title="Store as a write-only secret"
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ink-2)", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" }}
                >
                  <input type="checkbox" checked={v.secret} onChange={(e) => setVar(i, { secret: e.target.checked })} style={{ accentColor: "var(--accent)", cursor: "pointer" }} />
                  secret
                </label>
                <button className="btn" style={{ padding: "8px 10px" }} onClick={() => removeVar(i)} aria-label="Remove variable">
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
