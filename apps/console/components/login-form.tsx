"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
 * Minimal token-entry form for opt-in RBAC (see docs/DEPLOY.md, "RBAC
 * (optional)"). On submit this writes the `portico_token` cookie
 * client-side — there's no server-side login route — and sends the
 * browser to `/`; middleware re-checks the token on that next request and
 * bounces back to /login if it doesn't resolve to a role.
 *
 * The cookie is NOT httpOnly: nothing sets it server-side, so a script on
 * the page could in principle read it back. Accepted trade-off for a
 * minimal, backend-free login flow on a local, self-hosted console.
 *
 * Supports a `?token=` query param — the Members page's invite links
 * (components/members-manager.tsx) are `/login?token=...` — to prefill the
 * field. It only prefills: the human still has to click Continue, so
 * pre-fetching or merely opening the link can't sign anyone in by itself.
 */
function LoginFormFields() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [token, setToken] = useState(() => searchParams.get("token") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Enter a token.");
      return;
    }
    setBusy(true);
    setError(null);
    document.cookie = `portico_token=${encodeURIComponent(trimmed)}; path=/; samesite=lax`;
    router.push("/");
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
