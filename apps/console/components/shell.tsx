"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { IconConnectors, IconDash, IconFlows, IconRuns, IconSessions, IconSettings } from "./icons";

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
