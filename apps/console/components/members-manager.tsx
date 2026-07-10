"use client";

import { Fragment, useState } from "react";
import type { Role } from "@/lib/rbac";

/** One PORTICO_RBAC_TOKENS entry, as parsed server-side by app/members/page.tsx
 *  (via lib/rbac.ts parseTokens). The full token reaches this client
 *  component deliberately — building the "add" / "revoke" env lines below
 *  requires the real values of every OTHER member, the same way an admin
 *  editing the env var by hand would need them. The rendered table still
 *  only ever shows the masked form (see maskToken); nothing here calls out
 *  to a server, so nothing leaves the browser either way. */
export interface Member {
  token: string;
  role: Role;
  name: string;
}

const ROLES: Role[] = ["viewer", "operator", "admin"];

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-2)",
  marginBottom: 6,
};

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

/** Masks a token for display, revealing roughly a quarter of it from each
 *  end (capped at 4 chars/side so a long token still reads as "tok_…last4",
 *  the convention this page's own generator produces) — e.g.
 *  "tok_admin_12345" -> "tok_…2345". Generic over any prefix: a
 *  hand-configured token isn't required to start with "tok_". Never render
 *  the full token anywhere on this page. */
function maskToken(token: string): string {
  const visible = Math.min(4, Math.max(1, Math.floor(token.length / 4)));
  return `${token.slice(0, visible)}…${token.slice(-visible)}`;
}

/** Canonical env-entry string for one member. Keeps the compact "role:token"
 *  form when the name is just the role (the default for a plain 2-part
 *  entry), and only spells out "role:name:token" when a real name was set —
 *  both shapes are accepted by parseTokens (lib/rbac.ts). */
function serializeEntry(m: { role: string; name: string; token: string }): string {
  return m.name && m.name !== m.role ? `${m.role}:${m.name}:${m.token}` : `${m.role}:${m.token}`;
}

/** 32 hex chars (16 random bytes) prefixed "tok_", generated entirely in the
 *  browser via crypto.getRandomValues. This page makes no network requests
 *  at all — nothing here is ever sent anywhere. */
function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `tok_${hex}`;
}

/** Small copy button — mirrors components/json-view.tsx's CopyJsonButton
 *  (same "Copy" / "Copied ✓" toggle), just over an arbitrary string instead
 *  of a JSON value. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (permissions / insecure context) — stay quiet */
    }
  }

  return (
    <button
      type="button"
      className="btn"
      style={{ padding: "5px 11px", fontSize: 11.5, flex: "none" }}
      onClick={copy}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

/** A read-only code line with its own copy button, used for every env
 *  line / invite link this page produces. */
function CopyLine({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <pre
        className="code mono"
        style={{ flex: 1, minWidth: 0, margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 12 }}
      >
        {text}
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * Client half of app/members/page.tsx. Pure read + client-side generation —
 * there are no server mutations anywhere in this file. "Add member"
 * generates a token in the browser and shows the resulting env line/invite
 * link to copy elsewhere; each row's "Revoke" reveals the env line with
 * that one entry stripped out. Either way, the admin still has to paste the
 * result into PORTICO_RBAC_TOKENS and restart the console themselves.
 */
export function MembersManager({ members }: { members: Member[] }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [added, setAdded] = useState<Member | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeOpen, setRevokeOpen] = useState<string | null>(null);

  function addMember() {
    const trimmed = name.trim();
    if (!trimmed) {
      setAdded(null);
      setError("Enter a name.");
      return;
    }
    setError(null);
    setAdded({ name: trimmed, role, token: generateToken() });
  }

  // Only ever computed after addMember() runs from a click, so we're
  // definitely in the browser by the time `added` is set — no SSR guard
  // needed around window.location here.
  const newEnvLine = added ? [...members, added].map(serializeEntry).join(",") : "";
  const inviteLink = added ? `${window.location.origin}/login?token=${encodeURIComponent(added.token)}` : "";

  return (
    <div className="grid-2">
      <div className="panel" style={{ overflow: "hidden" }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Token</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const isOpen = revokeOpen === m.token;
              const revokeLine = members
                .filter((x) => x.token !== m.token)
                .map(serializeEntry)
                .join(",");
              return (
                <Fragment key={m.token}>
                  <tr>
                    <td style={{ fontWeight: 600 }}>{m.name}</td>
                    <td>
                      <span className="chip">{m.role}</span>
                    </td>
                    <td className="mono" style={{ color: "var(--ink-2)" }}>
                      {maskToken(m.token)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: "5px 11px", fontSize: 11.5 }}
                        onClick={() => setRevokeOpen(isOpen ? null : m.token)}
                      >
                        {isOpen ? "Cancel" : "Revoke…"}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={4} style={{ paddingTop: 0 }}>
                        <div style={{ padding: "2px 0 14px" }}>
                          <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 8 }}>
                            <span className="mono" style={{ color: "var(--ink-2)", fontWeight: 600 }}>
                              PORTICO_RBAC_TOKENS
                            </span>{" "}
                            with {m.name} removed — copy, replace the env value, and restart the console to
                            revoke access.
                          </div>
                          <CopyLine text={revokeLine || "(empty — removing the only member turns RBAC off)"} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="panel" style={{ padding: "22px 24px" }}>
        <div className="eyebrow" style={{ marginBottom: 18 }}>
          Add member
        </div>
        <div className="stack" style={{ gap: 16 }}>
          <div>
            <label style={labelStyle} htmlFor="member-name">
              Name
            </label>
            <input
              id="member-name"
              style={fieldStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. ravi"
              autoComplete="off"
            />
          </div>
          <div>
            <label style={labelStyle} htmlFor="member-role">
              Role
            </label>
            <select id="member-role" style={fieldStyle} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
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
          <button type="button" className="btn btn-primary" onClick={addMember}>
            Generate token
          </button>
        </div>

        {added && (
          <div
            className="stack"
            style={{ gap: 14, marginTop: 20, paddingTop: 20, borderTop: "1px solid var(--line)" }}
          >
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 6 }}>
                New PORTICO_RBAC_TOKENS value
              </div>
              <CopyLine text={newEnvLine} />
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-2)", marginBottom: 6 }}>
                Invite link for {added.name}
              </div>
              <CopyLine text={inviteLink} />
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-3)" }}>
              Append this to <span className="mono">PORTICO_RBAC_TOKENS</span> and restart the console to
              activate; share the invite link over a private channel.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
