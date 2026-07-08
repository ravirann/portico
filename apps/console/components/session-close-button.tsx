"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Per-row close control for the Sessions table. POSTs to the close route and
 *  refreshes so the session's health/status pill updates. */
export function SessionCloseButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function close() {
    setBusy(true);
    try {
      await fetch(`/api/sessions/${id}/close`, { method: "POST" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      className="btn"
      style={{ padding: "5px 12px", fontSize: 12 }}
      onClick={close}
      disabled={busy || disabled}
    >
      {busy ? "Closing…" : "Close"}
    </button>
  );
}
