/** @type {import('next').NextConfig} */
const nextConfig = {
  // The console never bundles the engine — live runs execute in a CLI
  // subprocess (Playwright/Libretto stay out of the Next build entirely).
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  devIndicators: false,
};

export default nextConfig;
