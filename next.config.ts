import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Enable async WebAssembly for webpack builds so libraw-wasm can run.
   * Turbopack ignores this and handles WASM automatically.
   */
  webpack: (config) => {
    config.experiments = {
      ...(config.experiments || {}),
      asyncWebAssembly: true,
    };
    return config;
  },
  /**
   * Define an (empty) Turbopack config so Next 16 doesn't complain about
   * having a webpack config without turbopack config.
   */
  turbopack: {},
};

export default nextConfig;
