"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MemberView } from "@/lib/types";

/**
 * DB-backed member management, rendered as the "Members" section of the
 * Settings page (app/settings/page.tsx). Members live in the store's
 * `members` table (raw tokens are never stored — only hashes — and never
 * appear in this component's props): Add posts /api/members, which returns
 * the new member's token EXACTLY ONCE for the admin to copy / send as an
 * invite link; Disable/Enable post /api/members/[id]/(disable|enable).
 * All three routes are admin-gated by middleware.
 *
 * Bootstrap: with zero members (and no env tokens) the console is open —
 * the same Add form doubles as "create the first admin" via
 * /api/members/bootstrap, after which enforcement turns on by itself
 * (middleware's /api/auth/status probe; ≤10s of cache lag).
 */

const ROLES = ["viewer", "operator", "admin"] as const;

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

interface Created {
  name: string;
  role: string;
  token: string;
}

export function MembersManager({ members, bootstrap }: { members: MemberView[]; bootstrap: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>(bootstrap ? "admin" : "operator");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function post(path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.error) {
        setError(String(data.error ?? `${path} failed`));
        return null;
      }
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    setBusy("add");
    const data = bootstrap
      ? await post("/api/members/bootstrap", { name: name.trim() })
      : await post("/api/members", { name: name.trim(), role });
    setBusy(null);
    if (data && typeof data.token === "string") {
      setCreated({ name: String(data.name), role: String(data.role), token: data.token });
      setName("");
      router.refresh();
    }
  }

  async function setDisabled(id: string, disabled: boolean) {
    setBusy(id);
    const data = await post(`/api/members/${id}/${disabled ? "disable" : "enable"}`);
    setBusy(null);
    if (data) router.refresh();
  }

  function copy(text: string, tag: string) {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(null), 1600);
    });
  }

  const inviteLink = created ? `${typeof window !== "undefined" ? window.location.origin : ""}/login?token=${encodeURIComponent(created.token)}` : "";

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* One-time token reveal for the member just created. */}
      {created && (
        <div
          className="panel"
          style={{ padding: "16px 18px", border: "1px solid var(--accent-line)", background: "var(--accent-wash)" }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            {created.name} ({created.role}) created — this token is shown ONCE
          </div>
          <div className="mono" style={{ fontSize: 12.5, wordBreak: "break-all", marginBottom: 10 }}>{created.token}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => copy(created.token, "tok")}>
              {copied === "tok" ? "Copied ✓" : "Copy token"}
            </button>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => copy(inviteLink, "link")}>
              {copied === "link" ? "Copied ✓" : "Copy invite link"}
            </button>
            <button className="btn" style={{ fontSize: 12, marginLeft: "auto" }} onClick={() => setCreated(null)}>
              Done — I stored it
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 8 }}>
            Share the invite link over a private channel; it prefills the sign-in form. The token cannot be recovered later — disable the member and add them again if it's lost.
          </div>
        </div>
      )}

      {/* Member table */}
      {members.length > 0 && (
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <table className="table" style={{ width: "100%" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>NAME</th>
                <th style={{ textAlign: "left" }}>ROLE</th>
                <th style={{ textAlign: "left" }}>STATUS</th>
                <th style={{ textAlign: "left" }}>LAST LOGIN</th>
                <th style={{ textAlign: "right" }}></th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} style={m.disabled ? { opacity: 0.55 } : undefined}>
                  <td style={{ fontWeight: 600 }}>{m.name}</td>
                  <td><span className="chip">{m.role}</span></td>
                  <td>{m.disabled ? "disabled" : "active"}</td>
                  <td style={{ fontSize: 12, color: "var(--ink-3)" }}>{m.lastLoginAt ? m.lastLoginAt.slice(0, 16).replace("T", " ") : "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn"
                      style={{ fontSize: 11.5, padding: "4px 10px" }}
                      disabled={busy !== null}
                      onClick={() => setDisabled(m.id, !m.disabled)}
                    >
                      {busy === m.id ? "…" : m.disabled ? "Enable" : "Disable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / bootstrap form */}
      <form className="panel" style={{ padding: "16px 18px" }} onSubmit={addMember}>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          {bootstrap ? "Create the first admin" : "Add a member"}
        </div>
        {bootstrap && (
          <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginBottom: 12 }}>
            This console is open until the first admin exists. Creating one turns on sign-in for everybody.
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: bootstrap ? "1fr auto" : "1fr 160px auto", gap: 12, alignItems: "end" }}>
          <div>
            <label style={labelStyle} htmlFor="member-name">Name</label>
            <input id="member-name" style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ravi" />
          </div>
          {!bootstrap && (
            <div>
              <label style={labelStyle} htmlFor="member-role">Role</label>
              <select id="member-role" style={fieldStyle} value={role} onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === "add" ? "Creating…" : bootstrap ? "Create admin" : "Add member"}
          </button>
        </div>
        {error && (
          <div
            style={{
              marginTop: 12,
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
      </form>
    </div>
  );
}
