"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

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
 * Token-entry form for the console's sign-in (see docs/DEPLOY.md, "Members
 * & access control"). Submits to POST /api/auth/login, which verifies the
 * token — an env static token or a DB member token — and mints the signed,
 * httpOnly `portico_session` cookie server-side. On success the browser is
 * sent to `/` with a FULL navigation (not router.push) so the very next
 * request middleware sees definitely carries the fresh cookie.
 *
 * Supports a `?token=` query param — the Members section's invite links
 * (components/members-manager.tsx) are `/login?token=...` — to prefill the
 * field. It only prefills: the human still has to click Continue, so
 * pre-fetching or merely opening the link can't sign anyone in by itself.
 */
function LoginFormFields() {
  const searchParams = useSearchParams();
  const [token, setToken] = useState(() => searchParams.get("token") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Enter a token.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok || data.error) {
        setError(data.error ?? "Sign-in failed.");
        setBusy(false);
        return;
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="panel" style={{ padding: "22px 24px", maxWidth: 420 }} onSubmit={submit}>
      <div className="eyebrow" style={{ marginBottom: 18 }}>Access token</div>
      <div className="stack" style={{ gap: 16 }}>
        <div>
          <label style={labelStyle} htmlFor="portico-token">Token</label>
          <input
            id="portico-token"
            style={fieldStyle}
            className="mono"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="tok_…"
            autoFocus
            autoComplete="off"
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: "10px 14px",
            borderRadius: "var(--radius-sm)",
            fontSize: 12.5,
            border: "1px solid oklch(0.86 0.05 27)",
            background: "var(--fail-wash)",
            color: "var(--fail)",
          }}
        >
          {error}
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

/** Suspense is required around anything calling useSearchParams (used above
 *  for the ?token= prefill) — without it, a client-side navigation to
 *  /login has no fallback to render while the search params resolve. */
export function LoginForm() {
  return (
    <Suspense fallback={null}>
      <LoginFormFields />
    </Suspense>
  );
}
