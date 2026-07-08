import { readSessions } from "./store";
import type { SessionView } from "./types";

/**
 * Connector-aware live-session picker shared by the validate and run routes.
 *
 * A flow should execute in the browser session logged into ITS portal, so
 * candidates are ordered: sessions scoped to the flow's connector first, then
 * unscoped ("any portal") sessions. A session scoped to a DIFFERENT connector
 * is never a candidate for a connector-scoped flow — replaying clicks inside
 * another portal's logged-in browser is a cross-portal hazard, so that case
 * errors instead of falling through. Only flows with no connector may use any
 * active session. A row being "active" doesn't mean its browser still exists
 * (closed window, reboot), so each candidate's CDP endpoint is probed and the
 * first one that answers wins. Read-only on the store: stale rows are skipped,
 * never mutated — the session lifecycle owns that.
 */

export interface PickedSession {
  session: SessionView;
  cdpEndpoint: string;
}

/** True when the CDP endpoint answers its version probe within 2s. */
async function isLive(cdpEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(cdpEndpoint + "/json/version", { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Pick the first LIVE session for a flow's connector (order above). Returns
 * the session or a precise, user-actionable error. `sessions` is injectable
 * for tests; defaults to the store's view.
 */
export async function pickLiveSession(
  connector: string | undefined,
  sessions: SessionView[] = readSessions(),
): Promise<PickedSession | { error: string }> {
  const active = sessions.filter((s) => s.status === "active" && s.cdpEndpoint);

  const matching = connector ? active.filter((s) => s.connector === connector) : [];
  const unscoped = active.filter((s) => !s.connector && !matching.includes(s));
  // Connector-scoped flows may ONLY use their own connector's sessions or
  // unscoped ones — never another connector's logged-in browser.
  const rest = connector ? [] : active.filter((s) => !matching.includes(s) && !unscoped.includes(s));

  for (const session of [...matching, ...unscoped, ...rest]) {
    if (await isLive(session.cdpEndpoint!)) {
      return { session, cdpEndpoint: session.cdpEndpoint! };
    }
  }

  const scope = connector ? ` for connector "${connector}"` : "";
  return {
    error: `No live browser session${scope} — start one on the Sessions page and log in, then try again.`,
  };
}
