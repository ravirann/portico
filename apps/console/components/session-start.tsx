"use client";

import { useEffect, useState } from "react";
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

interface ConnectorOption {
  key: string;
  name: string;
}

/** Start a local browser session from the console. Launches a real browser
 *  window on THIS machine (the console is self-hosted), so the copy is explicit
 *  about that. A session is scoped to a connector so it shows under that
 *  connector in the console (and is the one its flows record/validate against). */
export function SessionStart({ connector: initialConnector }: { connector?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tenant, setTenant] = useState("");
  const [profile, setProfile] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [port, setPort] = useState("");
  const [connector, setConnector] = useState(initialConnector ?? "");
  const [connectors, setConnectors] = useState<ConnectorOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Populate the connector picker (same source as the sidebar switcher).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/connectors/list")
      .then((r) => (r.ok ? r.json() : { connectors: [] }))
      .then((d: { connectors?: ConnectorOption[] }) => {
        if (!cancelled) setConnectors(Array.isArray(d.connectors) ? d.connectors : []);
      })
      .catch(() => {
        /* offline — the field still works, just without suggestions */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/sessions/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tenant: tenant.trim() || undefined,
          profile: profile.trim() || undefined,
          baseUrl: baseUrl.trim() || undefined,
          port: port.trim() || undefined,
          connector: connector.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setNote({ kind: "error", text: String(data.error ?? "Failed to start session") });
        return;
      }
      setNote({ kind: "ok", text: `Session started${data.id ? ` (${String(data.id)})` : ""}.` });
      setOpen(false);
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
          <IconPlay className="ico-sm" /> Start session
        </button>
        {note && (
          <span style={{ fontSize: 12.5, color: note.kind === "error" ? "var(--fail)" : "var(--accent)" }}>{note.text}</span>
        )}
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: "20px 22px", maxWidth: 640 }}>
      <div className="eyebrow" style={{ marginBottom: 6 }}>Start a session</div>
      <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 16 }}>
        Launches a browser window on <b>this machine</b> (self-hosted / local) and exposes its CDP endpoint for validation.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <label style={labelStyle}>Connector</label>
          <select style={fieldStyle} value={connector} onChange={(e) => setConnector(e.target.value)}>
            <option value="">— unassigned —</option>
            {connectors.map((c) => (
              <option key={c.key} value={c.key}>{c.name} ({c.key})</option>
            ))}
          </select>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>Scopes this session to a connector.</div>
        </div>
        <div>
          <label style={labelStyle}>Profile</label>
          <input style={fieldStyle} className="mono" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="default" />
        </div>
        <div>
          <label style={labelStyle}>Tenant</label>
          <input style={fieldStyle} value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="you" />
        </div>
        <div>
          <label style={labelStyle}>Base URL</label>
          <input style={fieldStyle} className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://portal.example.com" />
        </div>
        <div>
          <label style={labelStyle}>Port</label>
          <input style={fieldStyle} className="mono" value={port} onChange={(e) => setPort(e.target.value)} placeholder="9222" />
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
          {busy ? "Starting…" : "Launch browser"}
        </button>
        <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
