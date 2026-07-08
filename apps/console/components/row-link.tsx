"use client";

import { useRouter } from "next/navigation";

/** A whole table row that navigates to `href` on click or Enter — so the entire
 *  run row is clickable, not just the flow-name cell. Server pages render it as
 *  the <tr>; children are the <td>s. */
export function RowLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <tr
      className={className}
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(e) => {
        if (e.key === "Enter") router.push(href);
      }}
      style={{ cursor: "pointer" }}
    >
      {children}
    </tr>
  );
}
