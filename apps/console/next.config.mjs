/** @type {import('next').NextConfig} */
const nextConfig = {
  // Nothing native is bundled: live runs and store reads both go through the
  // CLI subprocess, keeping Playwright/Libretto/better-sqlite3 out of Next.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  devIndicators: false,
};

export default nextConfig;
