"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { listSectors, resolveSectorProfile } from "@portico/flow-spec";
import type { ConnectorOption } from "./new-flow-editor";
import type { ActiveSession } from "./record-flow";

// Same key rules as record/hand-authoring (start & end alphanumeric).
const KEY_RE = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
// All sector keys, "generic" first — @portico/flow-spec is pure data/functions
// (zero node deps), so it's safe to call at module scope in this Client Component.
// Widened to string[] so it can be compared against a connector record's plain
// (unvalidated) `sector` field without a type-narrowing cast at each call site.
const SECTOR_KEYS: string[] = listSectors();
// Where the in-flight async authoring job id is persisted, so leaving the page
// and coming back resumes the same run.
const LS_JOB_KEY = "portico:authorJob";

/** HH:MM:SS from an ISO timestamp, for the timeline. */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}
const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");

/** Prepend https:// when the user typed a bare domain (no scheme). */
function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}
/** A real http(s) URL with a dotted host (rejects "foo", accepts "a.com"). */
function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

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
  // Industry/app-class — tunes the author's reliability defaults. Defaults to
  // "generic"; if the initially-selected connector already declares a sector,
  // start there instead (same rule the connector <select> below applies on change).
  const [sector, setSector] = useState(() => {
    const s = connectors.find((c) => c.key === (initialConnector ?? ""))?.sector;
    return s && SECTOR_KEYS.includes(s) ? s : "generic";
  });
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [key, setKey] = useState("");
  // The active async authoring job. Authoring runs detached and reports into the
  // store; the component polls it, so the user can leave the page and come back.
  const [jobId, setJobId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [events, setEvents] = useState<{ ts: string; message: string }[]>([]);
  const timelineRef = useRef<HTMLDivElement>(null);
  const busy = jobId !== null;

  // Keep the timeline scrolled to the newest event as it streams in.
  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  // Resume an in-flight run after a reload / navigating back to this page.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LS_JOB_KEY);
      const id = saved ? (JSON.parse(saved) as { jobId?: string }).jobId : undefined;
      if (id) {
        setJobId(id);
        setNote({ kind: "ok", text: "Resuming your authoring run…" });
      }
    } catch {
      /* ignore malformed storage */
    }
  }, []);

  // Poll the job while one is active. Done → open the draft; failed → show why.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let missing = 0;
    const poll = async () => {
      try {
        const res = await fetch(`/api/flows/author?jobId=${encodeURIComponent(jobId)}`);
        const job = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (cancelled) return;
        // A stale saved id whose row no longer exists reports `missing`; give the
        // process a few seconds to create its row, then clear if it never does.
        if (job.missing) {
          if (++missing >= 5) {
            localStorage.removeItem(LS_JOB_KEY);
            setJobId(null);
            setNote(null);
          }
          return;
        }
        missing = 0;
        if (Array.isArray(job.events)) setEvents(job.events as { ts: string; message: string }[]);
        const status = String(job.status ?? "running");
        if (status === "done" && typeof job.draftFlowId === "string") {
          localStorage.removeItem(LS_JOB_KEY);
          setJobId(null);
          router.push(`/flows/${job.draftFlowId}?review=1`);
          return;
        }
        if (status === "failed") {
          localStorage.removeItem(LS_JOB_KEY);
          setJobId(null);
          setNote({ kind: "error", text: String(job.error ?? "Authoring failed.") });
          return;
        }
        // Running — the timeline is the live display; keep the note for errors only.
        setNote(null);
      } catch {
        /* transient network blip — keep polling */
      }
    };
    void poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, router]);

  const keyValid = key === "" || KEY_RE.test(key);
  const hasSession = sessions.length > 0;
  // Accept a bare domain — prepend https:// if no scheme was typed — then check
  // it's a real host. Users shouldn't have to type the scheme.
  const normalizedUrl = normalizeUrl(startUrl);
  const urlValid = isValidHttpUrl(normalizedUrl);

  // Explain WHY the button is disabled instead of a dead grey button.
  const disabledReason = !hasSession
    ? "Start a browser session first (Sessions page)."
    : goal.trim().length <= 8
      ? "Describe the goal in a sentence."
      : !urlValid
        ? "Enter the portal's URL (e.g. mychart.urmc.rochester.edu)."
        : !keyValid
          ? "Flow key must be lowercase letters, numbers, or hyphens."
          : null;
  const canSubmit = !disabledReason && !busy;

  async function author() {
    setNote({ kind: "ok", text: "Starting the agent…" });
    try {
      const res = await fetch("/api/flows/author", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          goal: goal.trim(),
          startUrl: normalizedUrl,
          connector: connector || undefined,
          key: key.trim() || undefined,
          sector,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error || !data.jobId) {
        setNote({ kind: "error", text: String(data.error ?? "Authoring failed to start.") });
        return;
      }
      // The run is now detached; persist the job id and let the poller take over.
      // Leaving the page is safe — returning resumes the same run.
      const id = String(data.jobId);
      try {
        localStorage.setItem(LS_JOB_KEY, JSON.stringify({ jobId: id, connector }));
      } catch {
        /* private mode — still works this session via state */
      }
      setJobId(id);
    } catch (e) {
      setNote({ kind: "error", text: e instanceof Error ? e.message : String(e) });
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
        <select
          id="aa-connector"
          style={fieldStyle}
          value={connector}
          onChange={(e) => {
            const next = e.target.value;
            setConnector(next);
            // Preselect the sector from the chosen connector's declared sector
            // (e.g. Gmail (web) → communications). If the connector has none,
            // leave whatever sector the user already has selected alone.
            const s = connectors.find((c) => c.key === next)?.sector;
            if (s && SECTOR_KEYS.includes(s)) setSector(s);
          }}
          disabled={busy}
        >
          <option value="">(no connector)</option>
          {connectors.map((c) => (
            <option key={c.key} value={c.key}>{c.name}</option>
          ))}
        </select>
      </div>

      <div>
        <label style={labelStyle} htmlFor="aa-sector">Sector</label>
        <select id="aa-sector" style={fieldStyle} value={sector} onChange={(e) => setSector(e.target.value)} disabled={busy}>
          {SECTOR_KEYS.map((k) => {
            const profile = resolveSectorProfile(k);
            return (
              <option key={k} value={k} title={profile.description}>
                {profile.name} — {profile.description}
              </option>
            );
          })}
        </select>
        <p style={helpStyle}>
          Sectors tune reliability defaults (timeouts, retries, locator strategy, safety guards) per app class;
          communications = keyboard-first, virtualized DOM (Gmail/Outlook/Slack).
        </p>
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

      {(busy || events.length > 0) && (
        <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius-sm)", background: "var(--wash)", overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 12px",
              borderBottom: "1px solid var(--line)",
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "var(--ink-3)",
            }}
          >
            <span>Authoring timeline</span>
            {busy && <span style={{ color: "var(--accent)", textTransform: "none", letterSpacing: 0 }}>● live</span>}
          </div>
          <div
            ref={timelineRef}
            style={{ maxHeight: 240, overflowY: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4 }}
          >
            {events.length === 0 ? (
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Waiting for the first step…</div>
            ) : (
              events.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: 10, fontSize: 12, lineHeight: 1.5, alignItems: "baseline" }}>
                  <span className="mono" style={{ color: "var(--ink-3)", fontSize: 10.5, flexShrink: 0, minWidth: 58 }}>
                    {fmtTime(e.ts)}
                  </span>
                  <span style={{ color: "var(--ink-2)", minWidth: 0, wordBreak: "break-word", overflowWrap: "anywhere" }}>
                    {e.message}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

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
        <button className="btn btn-primary" onClick={author} disabled={!canSubmit} title={disabledReason ?? undefined}>
          {busy ? "Authoring…" : "Author with agent"}
        </button>
        {busy && (
          <button
            className="btn"
            onClick={() => {
              try {
                localStorage.removeItem(LS_JOB_KEY);
              } catch {
                /* ignore */
              }
              setJobId(null);
              setNote(null);
            }}
          >
            Stop watching
          </button>
        )}
        <span style={{ fontSize: 11.5, color: disabledReason && !busy ? "var(--fail)" : "var(--ink-3)" }}>
          {busy
            ? "Runs in the background — you can leave this page and come back; it keeps going."
            : disabledReason && !busy
              ? disabledReason
              : "Produces a read-only draft you review before it can run."}
        </span>
      </div>
    </div>
  );
}
