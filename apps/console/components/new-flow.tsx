"use client";

import { AgentAuthor } from "./agent-author";
import type { ActiveSession } from "./record-flow";
import type { ConnectorOption } from "./new-flow-editor";

/** Flows are created by describing a goal — an AI agent drives the portal once,
 *  then the run is frozen into a deterministic, reviewable draft. (Recording and
 *  hand-authoring remain in the codebase but are no longer surfaced here.) */
export function NewFlow({
  connectors,
  sessions,
  initialConnector,
}: {
  connectors: ConnectorOption[];
  sessions: ActiveSession[];
  initialConnector?: string;
}) {
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div
        className="panel"
        style={{ padding: "14px 16px", background: "var(--wash)", border: "1px solid var(--line)" }}
      >
        <div className="seg-t" style={{ fontWeight: 600 }}>Author with an AI agent</div>
        <div className="seg-s" style={{ color: "var(--ink-3)", fontSize: 12.5, marginTop: 2 }}>
          Describe the goal in plain language. Portico plans it, an agent performs it once on your live
          session, and the run is frozen into a deterministic flow you review, validate, and confirm.
        </div>
      </div>
      <AgentAuthor connectors={connectors} sessions={sessions} initialConnector={initialConnector} />
    </div>
  );
}
