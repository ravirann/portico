import type { Metadata, Viewport } from "next";
import { Public_Sans, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Shell } from "@/components/shell";
import "./globals.css";

const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-public", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Portico — Automation Console",
  description: "Deterministic, self-healing, audited browser automation for authenticated portals.",
  icons: {
    icon: [
      { url: "/brand/portico-favicon.svg", type: "image/svg+xml" },
      { url: "/brand/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/brand/apple-touch-icon.png",
  },
  manifest: "/brand/site.webmanifest",
  openGraph: {
    title: "Portico — Automation Console",
    description: "Deterministic, self-healing, audited browser automation for authenticated portals.",
    images: ["/brand/og-image.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Portico — Automation Console",
    description: "Deterministic, self-healing, audited browser automation for authenticated portals.",
    images: ["/brand/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#2C7CB0" },
    { media: "(prefers-color-scheme: dark)", color: "#101922" },
  ],
};

// Apply the saved theme before first paint (no flash of the wrong theme).
// Absent → no data-theme attribute → follows the OS via prefers-color-scheme.
const themeScript = `(function(){try{var t=localStorage.getItem('portico-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Identity passthrough (see middleware.ts + lib/rbac.ts resolveIdentity):
  // both headers are only ever present when RBAC is on and the request
  // carried a valid token — middleware deletes them otherwise, so a client
  // can't forge them. Shell renders its signed-in block iff both are set.
  const requestHeaders = await headers();
  const role = requestHeaders.get("x-portico-role") ?? undefined;
  const user = requestHeaders.get("x-portico-user") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning className={`${publicSans.variable} ${mono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Shell user={user} role={role}>{children}</Shell>
      </body>
    </html>
  );
}
