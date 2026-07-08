"use client";

import { useState } from "react";
import { RecordFlow, type ActiveSession } from "./record-flow";
import { NewFlowEditor, type ConnectorOption } from "./new-flow-editor";

type Mode = "record" | "author";

/** The two ways to create a flow. Record-by-demonstration is the primary path
 *  (drive the portal, Portico compiles it); hand-authoring is the escape hatch
 *  for when you already know the steps. */
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
        <button role="tab" aria-selected={mode === "author"} className={mode === "author" ? "seg on" : "seg"} onClick={() => setMode("author")}>
          <span className="seg-t">Write YAML by hand</span>
          <span className="seg-s">You already know the steps</span>
        </button>
      </div>

      {mode === "record" ? (
        <RecordFlow connectors={connectors} sessions={sessions} initialConnector={initialConnector} />
      ) : (
        <NewFlowEditor connectors={connectors} initialConnector={initialConnector} />
      )}
    </div>
  );
}
