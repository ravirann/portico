"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { IconConnectors, IconDash, IconFlows, IconHelp, IconRuns, IconSessions, IconSettings } from "./icons";
import { ConnectorSwitcher } from "./connector-switcher";

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

const NAV = [
  { href: "/", label: "Overview", Icon: IconDash, exact: true },
  { href: "/runs", label: "Runs", Icon: IconRuns },
  { href: "/flows", label: "Flows", Icon: IconFlows },
  { href: "/sessions", label: "Sessions", Icon: IconSessions },
  { href: "/connectors", label: "Connectors", Icon: IconConnectors },
  { href: "/settings", label: "Settings", Icon: IconSettings },
  { href: "/help", label: "Help", Icon: IconHelp },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isActive = (href: string, exact?: boolean) =>
    exact ? path === href : path === href || path.startsWith(href + "/");

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand" aria-label="Portico">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo light" src="/brand/portico-logo.svg" alt="Portico" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-logo dark" src="/brand/portico-logo-dark.svg" alt="Portico" />
        </Link>

        <ConnectorSwitcher />

        <div className="nav-label">Workspace</div>
        {NAV.map(({ href, label, Icon, exact }) => (
          <Link key={href} href={href} className={`nav-item${isActive(href, exact) ? " active" : ""}`}>
            <Icon className="ico" />
            {label}
          </Link>
        ))}

        <div className="sidebar-foot">
          <ThemeSwitcher />
          <span className="self-host">
            <span className="pulse" />
            Self-hosted · local
          </span>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
