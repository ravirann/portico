"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPlay } from "./icons";

export function RunButton({ label = "Run a flow", flow, className = "btn btn-primary" }: { label?: string; flow?: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(flow ? { flow } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "run failed");
      router.push(`/runs/${data.id}`);
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      <button className={className} onClick={run} disabled={busy}>
        <IconPlay className="ico-sm" />
        {busy ? "Running…" : label}
      </button>
      {err && <span style={{ color: "var(--fail)", fontSize: 12.5 }}>{err}</span>}
    </span>
  );
}
