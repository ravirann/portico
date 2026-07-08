"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { IconConnectors, IconDash, IconFlows, IconRuns, IconSessions, IconSettings } from "./icons";

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const saved = localStorage.getItem("portico-theme");
    const initial =
      saved === "dark" || saved === "light"
        ? saved
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    setTheme(initial);
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("portico-theme", next);
    } catch {
      /* storage disabled — theme still applies for the session */
    }
  };
  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Toggle light or dark theme" title="Toggle theme">
      {theme === "dark" ? (
        <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
          <circle cx="8" cy="8" r="3.2" />
          <path d="M8 1v1.6M8 13.4V15M15 8h-1.6M2.6 8H1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1M12.7 12.7l-1.1-1.1M4.4 4.4 3.3 3.3" strokeLinecap="round" />
        </svg>
      )}
      <span>{theme === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}

const NAV = [
  { href: "/", label: "Overview", Icon: IconDash, exact: true },
  { href: "/runs", label: "Runs", Icon: IconRuns },
  { href: "/flows", label: "Flows", Icon: IconFlows },
  { href: "/sessions", label: "Sessions", Icon: IconSessions },
  { href: "/connectors", label: "Connectors", Icon: IconConnectors },
  { href: "/settings", label: "Settings", Icon: IconSettings },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const isActive = (href: string, exact?: boolean) =>
    exact ? path === href : path === href || path.startsWith(href + "/");

  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark" />
          <span className="brand-name">
            Portico<span className="dot">.</span>
          </span>
        </Link>

        <div className="nav-label">Workspace</div>
        {NAV.map(({ href, label, Icon, exact }) => (
          <Link key={href} href={href} className={`nav-item${isActive(href, exact) ? " active" : ""}`}>
            <Icon className="ico" />
            {label}
          </Link>
        ))}

        <div className="sidebar-foot">
          <ThemeToggle />
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
