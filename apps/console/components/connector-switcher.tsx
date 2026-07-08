"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

const COOKIE = "portico-connector";

interface ConnectorOption {
  key: string;
  name: string;
}

function readCookie(): string {
  if (typeof document === "undefined") return "";
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : "";
}

/** Sidebar connector scope switcher. Sets the `portico-connector` cookie (read
 *  server-side by the Runs/Flows pages to filter their lists) and refreshes so
 *  the scoped server components re-render. "all" (empty cookie) shows everything. */
export function ConnectorSwitcher() {
  const router = useRouter();
  const [connectors, setConnectors] = useState<ConnectorOption[]>([]);
  const [value, setValue] = useState<string>("all");

  useEffect(() => {
    const c = readCookie();
    setValue(c || "all");
    let cancelled = false;
    fetch("/api/connectors/list")
      .then((r) => (r.ok ? r.json() : { connectors: [] }))
      .then((d: { connectors?: ConnectorOption[] }) => {
        if (!cancelled) setConnectors(Array.isArray(d.connectors) ? d.connectors : []);
      })
      .catch(() => {
        /* offline / CLI unavailable — switcher still renders "All connectors" */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function select(next: string) {
    setValue(next);
    const oneYear = 60 * 60 * 24 * 365;
    const cookieVal = next === "all" ? "" : encodeURIComponent(next);
    // empty value + immediate expiry clears the cookie; otherwise persist a year
    document.cookie =
      next === "all"
        ? `${COOKIE}=; path=/; max-age=0; samesite=lax`
        : `${COOKIE}=${cookieVal}; path=/; max-age=${oneYear}; samesite=lax`;
    router.refresh();
  }

  const caret = useMemo(
    () => (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", color: "var(--ink-3)", pointerEvents: "none" }}
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    ),
    [],
  );

  return (
    <div style={{ padding: "2px 8px 4px" }}>
      <label
        style={{
          display: "block",
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: "0.13em",
          color: "var(--ink-3)",
          fontWeight: 600,
          margin: "0 0 6px 2px",
        }}
      >
        Connector
      </label>
      <div style={{ position: "relative" }}>
        <select
          value={value}
          onChange={(e) => select(e.target.value)}
          aria-label="Scope the console to a connector"
          style={{
            width: "100%",
            appearance: "none",
            WebkitAppearance: "none",
            padding: "8px 30px 8px 11px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--line)",
            background: "var(--paper-2)",
            color: "var(--ink)",
            fontFamily: "var(--font-body)",
            fontSize: 13,
            fontWeight: 500,
            lineHeight: 1.3,
            cursor: "pointer",
          }}
        >
          <option value="all">All connectors</option>
          {connectors.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
        {caret}
      </div>
    </div>
  );
}
