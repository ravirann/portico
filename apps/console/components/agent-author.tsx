"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ConnectorOption } from "./new-flow-editor";
import type { ActiveSession } from "./record-flow";

// Same key rules as record/hand-authoring (start & end alphanumeric).
const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 13px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--line-2)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontFamily: "var(--font-body)",
  fontSize: 13.5,
  lineHeight: 1.5,
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-2)",
  marginBottom: 7,
};
const helpStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--ink-3)", marginTop: 6, lineHeight: 1.5 };

/**
 * Author-with-AI-agent wizard. An LLM agent drives the connector's live browser
 * session toward a plain-language GOAL once; the run is frozen into a
 * deterministic draft flow you then verify, validate and confirm. The agent is
 * the AUTHOR, never the runtime — the compiled draft replays with no model.
 */
export function AgentAuthor({
  connectors,
  sessions,
  initialConnector,
}: {
  connectors: ConnectorOption[];
  sessions: ActiveSession[];
  initialConnector?: string;
}) {
  const router = useRouter();
  const [connector, setConnector] = useState(initialConnector ?? "");
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const keyValid = key === "" || KEY_RE.test(key);
  const canSubmit = goal.trim().length > 8 && /^https?:\/\//.test(startUrl.trim()) && keyValid && !busy;
  const hasSession = sessions.length > 0;

  async function author() {
    setBusy(true);
    setNote({ kind: "ok", text: "Agent is driving the portal toward your goal — this can take a minute…" });
    try {
      const res = await fetch("/api/flows/author", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: goal.trim(), startUrl: startUrl.trim(), connector: connector || undefined, key: key.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error || !data.draftId) {
        setNote({ kind: "error", text: String(data.error ?? "Authoring failed.") });
        return;
      }
      // Straight into the verification review, same as a recorded draft.
      router.push(`/flows/${String(data.draftId)}?review=1`);
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ display: "grid", gap: 20, padding: "24px 26px" }}>
      {!hasSession && (
        <div className="review-guard">
          No active browser session. Start one on the <b>Sessions</b> page and log into the portal — the agent
          drives that logged-in window.
        </div>
      )}

      <div>
        <label style={labelStyle} htmlFor="aa-connector">Connector</label>
        <select id="aa-connector" style={fieldStyle} value={connector} onChange={(e) => setConnector(e.target.value)} disabled={busy}>
          <option value="">(no connector)</option>
          {connectors.map((c) => (
            <option key={c.key} value={c.key}>{c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle} htmlFor="aa-goal">Goal</label>
        <textarea
          id="aa-goal"
          style={{ ...fieldStyle, minHeight: 70, resize: "vertical" }}
          placeholder="e.g. Open claim 4305's detail workspace and reveal its workflow review steps"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          disabled={busy}
        />
        <p style={helpStyle}>
          Plain language. The agent figures out the steps; Portico freezes them into a deterministic flow.
        </p>
      </div>

      <div>
        <label style={labelStyle} htmlFor="aa-url">Start URL</label>
        <input
          id="aa-url"
          style={fieldStyle}
          placeholder="https://pulse.clinikk.com/claims"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
          disabled={busy}
        />
      </div>

      <div>
        <label style={labelStyle} htmlFor="aa-key">Flow key <span style={{ fontWeight: 400, color: "var(--ink-3)" }}>(optional)</span></label>
        <input
          id="aa-key"
          className="mono"
          style={{ ...fieldStyle, borderColor: keyValid ? "var(--line-2)" : "var(--fail)" }}
          placeholder="claim-detail"
          value={key}
          onChange={(e) => setKey(slugify(e.target.value))}
          disabled={busy}
        />
      </div>

      {note && (
        <div
          className="review-result"
          style={
            note.kind === "error"
              ? { background: "var(--fail-wash)", borderColor: "oklch(0.86 0.05 27)", color: "var(--fail)" }
              : undefined
          }
        >
          {note.text}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 20, marginTop: 2 }}>
        <button className="btn btn-primary" onClick={author} disabled={!canSubmit || !hasSession}>
          {busy ? "Authoring…" : "Author with agent"}
        </button>
        <span style={{ fontSize: 11.5, color: "var(--ink-3)" }}>
          Produces a read-only draft you review before it can run.
        </span>
      </div>
    </div>
  );
}
