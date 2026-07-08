"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconPlay, IconPlus } from "./icons";
import type { ConnectorOption } from "./new-flow-editor";

export interface ActiveSession {
  id: string;
  tenant: string;
  profile?: string;
  cdpEndpoint?: string;
}

// Must start AND end alphanumeric; hyphens/underscores allowed inside. Keep in
// sync with the server-side KEY_RE in /api/recordings/start and /api/flows.
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

/**
 * Record-by-demonstration wizard. Attaches a recorder to an ACTIVE browser
 * session (you log in once there), you demonstrate the task in that window, then
 * Stop compiles the capture into a draft and drops you into the verification
 * review. No YAML by hand.
 */
export function RecordFlow({
  connectors,
  sessions,
  initialConnector,
}: {
  connectors: ConnectorOption[];
  sessions: ActiveSession[];
  initialConnector?: string;
}) {
  const router = useRouter();
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [connector, setConnector] = useState(initialConnector ?? "");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [intercept, setIntercept] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [phase, setPhase] = useState<"setup" | "recording" | "compiling">("setup");
  const [recId, setRecId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Live capture stats polled from /api/recordings/<recId> while recording.
  const [live, setLive] = useState<{ attached: boolean; liveClicks: number; liveRequests: number } | null>(null);
  // Flips true ~8s into a capture; if the recorder still hasn't attached by
  // then, the UI shows a warning instead of silently recording nothing.
  const [attachTimedOut, setAttachTimedOut] = useState(false);

  const keyValid = KEY_RE.test(key);
  const activeSession = sessions.find((s) => s.id === sessionId);

  // RESUME: an in-progress capture survives navigation (the recorder is a
  // detached process), but the wizard used to forget its recId — orphaning the
  // recording forever. On mount / session change, jump back into it.
  useEffect(() => {
    if (phase !== "setup" || !sessionId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/recordings?session=${encodeURIComponent(sessionId)}`);
        const data = (await res.json().catch(() => ({}))) as { recordings?: Array<{ id?: string; status?: string }> };
        const inProgress = (data.recordings ?? []).find((r) => r.status === "recording");
        if (!cancelled && inProgress?.id) {
          setRecId(String(inProgress.id));
          setPhase("recording");
          setNote(null);
        }
      } catch {
        /* lookup is best-effort — the user can still start a fresh recording */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Poll live capture stats every 2s while recording; stop on unmount/stop.
  useEffect(() => {
    if (phase !== "recording" || !recId) return;
    let cancelled = false;
    setLive(null);
    setAttachTimedOut(false);
    const poll = async () => {
      try {
        const res = await fetch(`/api/recordings/${recId}`);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled || !res.ok || data.error) return;
        setLive({
          attached: Boolean(data.attached),
          liveClicks: Number(data.liveClicks ?? 0),
          liveRequests: Number(data.liveRequests ?? 0),
        });
      } catch {
        /* transient — try again on the next tick */
      }
    };
    void poll();
    const interval = setInterval(poll, 2000);
    const attachTimer = setTimeout(() => {
      if (!cancelled) setAttachTimedOut(true);
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(attachTimer);
    };
  }, [phase, recId]);

  async function start() {
    if (!sessionId) return setNote({ kind: "error", text: "Pick an active session to record against." });
    if (!keyValid) return setNote({ kind: "error", text: "Enter a key: lowercase letters, numbers, hyphens or underscores; start and end with a letter or number." });
    setPhase("compiling");
    setNote(null);
    try {
      const res = await fetch("/api/recordings/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, key, connector: connector || undefined, baseUrl: baseUrl.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setPhase("setup");
        setNote({ kind: "error", text: String(data.error ?? "Could not start recording.") });
        return;
      }
      setRecId(String(data.recordingId));
      setPhase("recording");
    } catch (e) {
      setPhase("setup");
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  async function stop() {
    if (!recId) return;
    setPhase("compiling");
    setNote(null);
    try {
      const res = await fetch(`/api/recordings/${recId}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intercept: intercept.trim() || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setPhase("recording");
        setNote({ kind: "error", text: String(data.error ?? "Could not compile the recording.") });
        return;
      }
      if (typeof data.draftId === "string") {
        router.push(`/flows/${data.draftId}?review=1`);
        router.refresh();
        return;
      }
      setPhase("setup");
      setNote({ kind: "error", text: "Compiled, but no draft id was returned." });
    } catch (e) {
      setPhase("recording");
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  }

  // No live browser to record against — the whole flow needs one.
  if (sessions.length === 0) {
    return (
      <div className="panel" style={{ padding: "26px 24px" }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Record</div>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 19, fontWeight: 560, marginBottom: 8 }}>
          Start a browser session first
        </div>
        <p style={{ color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.55, maxWidth: "60ch", marginBottom: 18 }}>
          Recording attaches to a live, logged-in browser so you log in once and the same session validates the flow.
          Launch one, sign in to the portal, then come back here to record.
        </p>
        <Link href="/sessions" className="btn btn-primary">
          <IconPlay className="ico-sm" /> Go to Sessions
        </Link>
      </div>
    );
  }

  const noteBox = note && (
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
  );

  if (phase === "recording" || (phase === "compiling" && recId)) {
    return (
      <div className="panel" style={{ padding: "24px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span className="rec-dot" />
          <span style={{ fontFamily: "var(--font-display)", fontSize: 19, fontWeight: 560 }}>Recording…</span>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", marginLeft: "auto" }}>{recId}</span>
        </div>
        <ol style={{ margin: "0 0 8px", paddingLeft: 18, color: "var(--ink-2)", fontSize: 13.5, lineHeight: 1.7 }}>
          <li>The browser window for session <b className="mono">{sessionId}</b>{activeSession?.profile ? ` (${activeSession.profile})` : ""} has been brought to the front.</li>
          <li>Log in if needed, then <b>demonstrate the task</b> click by click.</li>
          <li><b style={{ color: "var(--fail)" }}>Stop before any booking / submit / pay</b> — Portico captures a read-only harvest.</li>
          <li>Come back and press <b>Stop &amp; compile</b>.</li>
        </ol>
        <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 10 }}>
          {live?.attached
            ? `● capturing — ${live.liveClicks} ${live.liveClicks === 1 ? "click" : "clicks"} · ${live.liveRequests} ${live.liveRequests === 1 ? "request" : "requests"}`
            : "● waiting for the recorder to attach…"}
        </div>
        {attachTimedOut && !live?.attached && (
          <div
            style={{
              marginTop: 10,
              padding: "10px 14px",
              borderRadius: "var(--radius-sm)",
              fontSize: 12.5,
              border: "1px solid oklch(0.86 0.05 27)",
              background: "var(--fail-wash)",
              color: "var(--fail)",
            }}
          >
            The recorder hasn&apos;t attached yet — check that the session browser is still open.
          </div>
        )}
        {noteBox}
        <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center" }}>
          <button className="btn btn-primary" onClick={stop} disabled={phase === "compiling"}>
            {phase === "compiling" ? "Compiling…" : "Stop & compile"}
          </button>
          {live && live.liveClicks === 0 ? (
            <span style={{ fontSize: 12, color: "var(--fail)" }}>no clicks captured yet</span>
          ) : (
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>compiles the capture into a reviewable draft</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="panel" style={{ padding: "20px 22px" }}>
        <div className="eyebrow" style={{ marginBottom: 16 }}>Record setup</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <label style={labelStyle}>Session</label>
            <select style={fieldStyle} className="mono" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>{s.id}{s.profile ? ` · ${s.profile}` : ""}</option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>
              The logged-in browser you&apos;ll demonstrate in. <Link href="/sessions" style={{ color: "var(--accent)" }}>Manage sessions</Link>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Flow key</label>
            <input style={fieldStyle} className="mono" value={key} onChange={(e) => setKey(slugify(e.target.value))} placeholder="book-appointment" />
            <div style={{ fontSize: 11, color: key && !keyValid ? "var(--fail)" : "var(--ink-3)", marginTop: 4 }}>
              Lowercase letters, numbers, hyphens or underscores; start and end with a letter or number.
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label style={labelStyle}>Connector</label>
            <select style={fieldStyle} value={connector} onChange={(e) => setConnector(e.target.value)}>
              <option value="">— unassigned —</option>
              {connectors.map((c) => (
                <option key={c.key} value={c.key}>{c.name} ({c.key}){c.editable ? "" : " · seed"}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          className="btn"
          style={{ marginTop: 14, padding: "5px 11px", fontSize: 12 }}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Hide advanced" : "Advanced"}
        </button>
        {showAdvanced && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 14 }}>
            <div>
              <label style={labelStyle}>Start URL (optional)</label>
              <input style={fieldStyle} className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://portal…/Scheduling" />
            </div>
            <div>
              <label style={labelStyle}>Intercept hint (optional)</label>
              <input style={fieldStyle} className="mono" value={intercept} onChange={(e) => setIntercept(e.target.value)} placeholder="GetSlots" />
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>Data endpoint keyword to harvest.</div>
            </div>
          </div>
        )}
        {noteBox}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn btn-primary" onClick={start} disabled={!keyValid || !sessionId || phase === "compiling"}>
          <IconPlay className="ico-sm" /> {phase === "compiling" ? "Starting…" : "Start recording"}
        </button>
        <button className="btn" onClick={() => router.push("/flows")}>Cancel</button>
        <span style={{ fontSize: 12, color: "var(--ink-3)", display: "inline-flex", alignItems: "center", gap: 5 }}>
          <IconPlus className="ico-sm" /> opens capture in session {sessionId || "—"}
        </span>
      </div>
    </div>
  );
}
