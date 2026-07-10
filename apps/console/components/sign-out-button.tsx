"use client";

/**
 * Sidebar "Sign out" control (rendered inside components/shell.tsx's
 * signed-in block). There's no server-side session — RBAC only ever reads
 * the `portico_token` cookie (see lib/rbac.ts extractToken / the login flow
 * in components/login-form.tsx) — so signing out is just clearing that
 * cookie and sending the browser to /login. A full navigation, not
 * router.push/refresh: that guarantees the very next request middleware
 * sees carries no cookie at all, rather than racing a client-side
 * transition against the cookie write.
 *
 * This does not revoke the token itself (see docs/DEPLOY.md, "Managing
 * members") — only the browser's copy of it.
 */
export function SignOutButton() {
  function signOut() {
    document.cookie = "portico_token=; path=/; max-age=0; samesite=lax";
    window.location.href = "/login";
  }

  return (
    <button
      type="button"
      className="btn"
      style={{ width: "100%", justifyContent: "center", padding: "6px 10px", fontSize: 12 }}
      onClick={signOut}
    >
      Sign out
    </button>
  );
}
