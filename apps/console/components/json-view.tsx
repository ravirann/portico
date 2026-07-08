"use client";

import { useRef, useState } from "react";

/** Syntax-colored, indented JSON tree for run output panels.
 *  Client component only so CopyJsonButton can live in the same file — the
 *  tree itself is pure JSX (no hooks/handlers) and server-renders fine via SSR.
 *  Arrays longer than MAX_ARRAY_ITEMS are truncated with a "… N more items"
 *  marker so deep harvested payloads stay scannable. */

const MAX_ARRAY_ITEMS = 20;

function Primitive({ v }: { v: unknown }) {
  if (v === null) return <span className="jv-null">null</span>;
  if (typeof v === "string") return <span className="jv-str">{JSON.stringify(v)}</span>;
  if (typeof v === "number") return <span className="jv-num">{String(v)}</span>;
  if (typeof v === "boolean") return <span className="jv-bool">{String(v)}</span>;
  // undefined / function / symbol — JSON.stringify would drop these; show as null
  return <span className="jv-null">null</span>;
}

function Entry({ k, v, last }: { k?: string; v: unknown; last: boolean }) {
  const keyPart =
    k !== undefined ? (
      <>
        <span className="jv-key">{JSON.stringify(k)}</span>
        <span className="jv-p">: </span>
      </>
    ) : null;
  const comma = last ? null : <span className="jv-p">,</span>;

  if (v !== null && typeof v === "object") {
    const isArr = Array.isArray(v);
    const entries: [string | undefined, unknown][] = isArr
      ? (v as unknown[]).map((item) => [undefined, item])
      : Object.entries(v as Record<string, unknown>).map(([ck, cv]) => [ck, cv]);
    const hidden = isArr && entries.length > MAX_ARRAY_ITEMS ? entries.length - MAX_ARRAY_ITEMS : 0;
    const shown = hidden > 0 ? entries.slice(0, MAX_ARRAY_ITEMS) : entries;

    if (entries.length === 0) {
      return (
        <div className="jv-row">
          {keyPart}
          <span className="jv-p">{isArr ? "[]" : "{}"}</span>
          {comma}
        </div>
      );
    }

    return (
      <>
        <div className="jv-row">
          {keyPart}
          <span className="jv-p">{isArr ? "[" : "{"}</span>
        </div>
        <div className="jv-nest">
          {shown.map(([ck, cv], i) => (
            <Entry key={ck ?? i} k={ck} v={cv} last={hidden === 0 && i === shown.length - 1} />
          ))}
          {hidden > 0 && <div className="jv-row jv-more">… {hidden} more items</div>}
        </div>
        <div className="jv-row">
          <span className="jv-p">{isArr ? "]" : "}"}</span>
          {comma}
        </div>
      </>
    );
  }

  return (
    <div className="jv-row">
      {keyPart}
      <Primitive v={v} />
      {comma}
    </div>
  );
}

export function JsonView({ data }: { data: unknown }) {
  return (
    <div className="jv">
      <Entry v={data} last />
    </div>
  );
}

/** Small ghost copy button for panel headers — copies the pretty-printed JSON. */
export function CopyJsonButton({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (permissions / insecure context) — stay quiet
    }
  }

  return (
    <button type="button" className="btn jv-copy" onClick={copy} aria-live="polite">
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}
