"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconEdit, IconTrash } from "./icons";

/** Row controls for a DB-backed connector: edit link + delete-with-confirm. */
export function ConnectorActions({ id, editKey, name }: { id: string; editKey: string; name: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function del() {
    setBusy(true);
    try {
      const res = await fetch(`/api/connectors/${id}`, { method: "DELETE" });
      if (res.ok) router.refresh();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <Link href={`/connectors/${editKey}`} className="btn" style={{ padding: "6px 12px", fontSize: 12.5 }}>
        <IconEdit className="ico-sm" /> Edit
      </Link>
      {confirming ? (
        <>
          <button className="btn" style={{ padding: "6px 12px", fontSize: 12.5, color: "var(--fail)", borderColor: "oklch(0.86 0.05 27)" }} onClick={del} disabled={busy}>
            {busy ? "Deleting…" : `Delete ${name}?`}
          </button>
          <button className="btn" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </>
      ) : (
        <button className="btn" style={{ padding: "6px 12px", fontSize: 12.5 }} onClick={() => setConfirming(true)} aria-label={`Delete ${name}`}>
          <IconTrash className="ico-sm" />
        </button>
      )}
    </div>
  );
}
