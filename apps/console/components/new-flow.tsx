"use client";

import { useState } from "react";
import { RecordFlow, type ActiveSession } from "./record-flow";
import { AgentAuthor } from "./agent-author";
import { NewFlowEditor, type ConnectorOption } from "./new-flow-editor";

type Mode = "record" | "agent" | "manual";

/** The three ways to create a flow. Record-by-demonstration and author-by-goal
 *  (an AI agent drives the portal, then the run is frozen into a deterministic
 *  draft) are the guided paths; hand-authoring is the escape hatch for when you
 *  already know the steps. */
export function NewFlow({
  connectors,
  sessions,
  initialConnector,
}: {
  connectors: ConnectorOption[];
  sessions: ActiveSession[];
  initialConnector?: string;
}) {
  const [mode, setMode] = useState<Mode>("record");

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="segmented" role="tablist" aria-label="How to create the flow">
        <button role="tab" aria-selected={mode === "record"} className={mode === "record" ? "seg on" : "seg"} onClick={() => setMode("record")}>
          <span className="seg-t">Record a demonstration</span>
          <span className="seg-s">Drive the portal once — Portico compiles the steps</span>
        </button>
        <button role="tab" aria-selected={mode === "agent"} className={mode === "agent" ? "seg on" : "seg"} onClick={() => setMode("agent")}>
          <span className="seg-t">Author with AI agent</span>
          <span className="seg-s">Describe a goal — an agent drives it, then it&apos;s frozen deterministic</span>
        </button>
        <button role="tab" aria-selected={mode === "manual"} className={mode === "manual" ? "seg on" : "seg"} onClick={() => setMode("manual")}>
          <span className="seg-t">Write YAML by hand</span>
          <span className="seg-s">You already know the steps</span>
        </button>
      </div>

      {mode === "record" && <RecordFlow connectors={connectors} sessions={sessions} initialConnector={initialConnector} />}
      {mode === "agent" && <AgentAuthor connectors={connectors} sessions={sessions} initialConnector={initialConnector} />}
      {mode === "manual" && <NewFlowEditor connectors={connectors} initialConnector={initialConnector} />}
    </div>
  );
}
