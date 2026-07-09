"use client";

import { useState } from "react";
import { JsonView, CopyJsonButton } from "./json-view";
import { fmtDuration } from "@/lib/format";
import type { StepView } from "@/lib/types";

/** Step timeline with each captured output rendered inline under the step that
 *  produced it, so it's obvious which step yielded which structured data.
 *
 *  Producing step is inferred from the step detail: capture/intercept steps
 *  carry a "→ <key>" arrow naming the output key they write. Keys with no
 *  matching step fall back to an "Unattributed output" group below the steps so
 *  no data is ever silently dropped. */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** key -> index of the step that produced it (best-effort), plus any leftovers. */
function attributeOutput(
  steps: StepView[],
  output: Record<string, unknown> | undefined,
): { byStep: Map<number, string[]>; unattributed: string[] } {
  const byStep = new Map<number, string[]>();
  const unattributed: string[] = [];
  for (const key of Object.keys(output ?? {})) {
    // Derived companions (e.g. "data_raw__count") are written by the same step
    // as their base capture, so fall back to matching the base name.
    const base = key.split("__")[0];
    const names = base !== key ? [key, base] : [key];
    const arrow = names.map((n) => new RegExp("→\\s*" + escapeRegExp(n) + "\\b"));
    const word = names.map((n) => new RegExp("\\b" + escapeRegExp(n) + "\\b"));
    // Prefer the step that explicitly writes the key ("→ key"); else the first
    // step to mention it; else leave it unattributed.
    const producer =
      steps.find((s) => s.detail && arrow.some((re) => re.test(s.detail!))) ??
      steps.find((s) => s.detail && word.some((re) => re.test(s.detail!)));
    if (producer) {
      const list = byStep.get(producer.index) ?? [];
      list.push(key);
      byStep.set(producer.index, list);
    } else {
      unattributed.push(key);
    }
  }
  return { byStep, unattributed };
}

function OutputDisclosure({ name, value }: { name: string; value: unknown }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="step-output">
      <div className="step-output-head">
        <button
          type="button"
          className="step-output-toggle"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <span className={`step-output-caret${open ? " open" : ""}`} aria-hidden>▸</span>
          <span className="step-output-key mono">{name}</span>
          <span className="step-output-tag">output</span>
        </button>
        <CopyJsonButton data={value} />
      </div>
      {open && <JsonView data={value} />}
    </div>
  );
}

export function StepTimeline({
  steps,
  output,
}: {
  steps: StepView[];
  output?: Record<string, unknown>;
}) {
  const { byStep, unattributed } = attributeOutput(steps, output);

  return (
    <div className="timeline">
      {steps.map((s) => {
        const keys = byStep.get(s.index) ?? [];
        return (
          <div key={s.index} className={`step ${s.status}`}>
            <div className="step-dot">
              {s.status === "failed" ? "!" : s.status === "healed" ? "↻" : s.index + 1}
            </div>
            <div className="step-body">
              <div className="step-label">{s.label ?? s.type}</div>
              <div className="step-type">{s.type}{s.status === "healed" ? " · self-healed" : ""}</div>
              {s.detail && <div className="step-detail">{s.detail}</div>}
              {keys.map((k) => (
                <OutputDisclosure key={k} name={k} value={output?.[k]} />
              ))}
            </div>
            <div className="step-dur">{fmtDuration(s.durationMs)}</div>
          </div>
        );
      })}

      {unattributed.length > 0 && (
        <div className="step">
          <div className="step-dot">·</div>
          <div className="step-body">
            <div className="step-label">Unattributed output</div>
            <div className="step-type">not tied to a single step</div>
            {unattributed.map((k) => (
              <OutputDisclosure key={k} name={k} value={output?.[k]} />
            ))}
          </div>
          <div className="step-dur" />
        </div>
      )}
    </div>
  );
}
