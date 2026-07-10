"use client";

/**
 * Sidebar "Sign out" control (rendered inside components/shell.tsx's
 * signed-in block). POSTs /api/auth/logout to expire the httpOnly
 * `portico_session` cookie server-side, also clears the legacy client-set
 * `portico_token` cookie (env static-token logins), then does a FULL
 * navigation to /login — not router.push — so the very next request
 * middleware sees carries no credentials at all.
 *
 * This does not revoke the member's token itself (see docs/DEPLOY.md,
 * "Members & access control") — only this browser's session.
 */
export function SignOutButton() {
  async function signOut() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* cookie clear below still runs; middleware re-checks on navigation */
    }
    document.cookie = "portico_token=; path=/; max-age=0; samesite=lax";
    window.location.href = "/login";
  }

  return (
    <button
      type="button"
      className="btn"
      style={{ padding: "4px 10px", fontSize: 11.5 }}
      onClick={signOut}
    >
      Sign out
    </button>
  );
}
