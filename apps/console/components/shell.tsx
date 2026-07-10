"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { IconAudit, IconConnectors, IconDash, IconFlows, IconHelp, IconRuns, IconSessions, IconSettings } from "./icons";
import { ConnectorSwitcher } from "./connector-switcher";
import { SignOutButton } from "./sign-out-button";

type ThemeMode = "dark" | "light" | "system";

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: React.ReactNode }[] = [
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    value: "light",
    label: "Light",
    icon: (
      <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <circle cx="8" cy="8" r="3.2" />
        <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="1.5" y="2.5" width="13" height="9" rx="1.2" />
        <path d="M6 14h4M8 11.5V14" strokeLinecap="round" />
      </svg>
    ),
  },
];

function ThemeSwitcher() {
  // Default follows the device — absent stored preference means no data-theme
  // attribute, so the app tracks prefers-color-scheme (see layout.tsx).
  const [mode, setMode] = useState<ThemeMode>("system");
  useEffect(() => {
    const saved = localStorage.getItem("portico-theme");
    setMode(saved === "dark" || saved === "light" ? saved : "system");
  }, []);
  const apply = (next: ThemeMode) => {
    setMode(next);
    const root = document.documentElement;
    if (next === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", next);
    }
    try {
      if (next === "system") localStorage.removeItem("portico-theme");
      else localStorage.setItem("portico-theme", next);
    } catch {
      /* storage disabled — theme still applies for the session */
    }
  };
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Color theme">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={mode === opt.value}
          aria-label={opt.label}
          title={opt.label}
          className={`theme-seg${mode === opt.value ? " active" : ""}`}
          onClick={() => apply(opt.value)}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  );
}

interface NavItem {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  exact?: boolean;
  /** Hidden from the rendered nav when RBAC is on and the signed-in role
   *  isn't admin (see Shell below) — a viewer/operator following this link
   *  would just be redirected home by middleware (lib/rbac.ts requiredRole).
   *  Shown when RBAC is off entirely, since /members then renders its own
   *  "RBAC is off" how-to-enable state instead of gating anything. */
  adminOnly?: boolean;
}

// Members management lives on the Settings page (its "Members" section) —
// no separate nav entry; /members redirects there for old links.
const NAV: NavItem[] = [
  { href: "/", label: "Overview", Icon: IconDash, exact: true },
  { href: "/runs", label: "Runs", Icon: IconRuns },
  { href: "/flows", label: "Flows", Icon: IconFlows },
  { href: "/sessions", label: "Sessions", Icon: IconSessions },
  { href: "/connectors", label: "Connectors", Icon: IconConnectors },
  { href: "/audit", label: "Audit", Icon: IconAudit },
  { href: "/settings", label: "Settings", Icon: IconSettings },
  { href: "/help", label: "Help", Icon: IconHelp },
];

export function Shell({
  children,
  user,
  role,
}: {
  children: React.ReactNode;
  /** Signed-in identity, forwarded by middleware.ts as request headers and
   *  read server-side in app/layout.tsx. Both are undefined whenever RBAC
   *  is off (or the request carries no valid token) — in that case this
   *  component renders exactly as it did before these props existed. */
  user?: string;
  role?: string;
}) {
  const path = usePathname();
  const isActive = (href: string, exact?: boolean) =>
    exact ? path === href : path === href || path.startsWith(href + "/");
  const visibleNav = NAV.filter((item) => !item.adminOnly || !role || role === "admin");

  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("portico-sidebar-collapsed") === "1") setCollapsed(true);
    } catch {
      /* storage disabled — sidebar just stays expanded for the session */
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("portico-sidebar-collapsed", next ? "1" : "0");
      } catch {
        /* storage disabled — collapse still applies for the session */
      }
      return next;
    });
  };

  return (
    <div className={`shell${collapsed ? " collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link href="/" className="brand" aria-label="Portico">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-logo light" src="/brand/portico-logo.svg" alt="Portico" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-logo dark" src="/brand/portico-logo-dark.svg" alt="Portico" />
          </Link>
          <button
            type="button"
            className="rail-toggle"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
              {collapsed ? (
                <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
              ) : (
                <path d="M10 3.5 5.5 8 10 12.5" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        </div>

        <div className="connector-switcher-wrap">
          <ConnectorSwitcher />
        </div>

        <div className="nav-label">Workspace</div>
        {visibleNav.map(({ href, label, Icon, exact }) => (
          <Link
            key={href}
            href={href}
            title={label}
            className={`nav-item${isActive(href, exact) ? " active" : ""}`}
          >
            <Icon className="ico" />
            <span className="nav-text">{label}</span>
          </Link>
        ))}

        <div className="sidebar-foot">
          {/* One compact row: deployment badge left, theme control right. */}
          <div className="foot-row">
            <span className="self-host">
              <span className="pulse" />
              <span className="self-host-text">Self-hosted · local</span>
            </span>
            <ThemeSwitcher />
          </div>
          {/* Who-am-I + sign out, one slim row. Only present when the request
              carried a valid identity (see app/layout.tsx); absent entirely
              otherwise — zero visual change for the open single-user setup.
              Hidden while the rail is collapsed (no room in a 64px rail). */}
          {!collapsed && user && role && (
            <div className="foot-row" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
              <span
                title={`${user} (${role})`}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {user}
                </span>
                <span className="chip" style={{ flexShrink: 0 }}>{role}</span>
              </span>
              <SignOutButton />
            </div>
          )}
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
