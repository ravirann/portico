/** @type {import('next').NextConfig} */
const nextConfig = {
  // Nothing native is bundled: live runs and store reads both go through the
  // CLI subprocess, keeping Playwright/better-sqlite3 out of Next. PURE
  // workspace packages (zero-dep TS like @portico/flow-spec) may be imported
  // directly — transpilePackages compiles their TS source, and extensionAlias
  // teaches webpack the NodeNext ".js" specifier → ".ts" source mapping those
  // packages use internally.
  transpilePackages: ["@portico/flow-spec"],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  devIndicators: false,
};

export default nextConfig;
