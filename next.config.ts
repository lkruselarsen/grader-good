import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /** Don't bundle dcraw so runtime patch (const→let) is loaded from node_modules. */
  serverExternalPackages: ["dcraw", "libraw-wasm", "lightdrift-libraw"],
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  /**
   * Enable async WebAssembly for webpack builds so libraw-wasm can run.
   * Turbopack ignores this and handles WASM automatically.
   */
  webpack: (config) => {
    config.experiments = {
      ...(config.experiments || {}),
      asyncWebAssembly: true,
    };
    // libraw-wasm em-pthread chunks cause webpack's gzip filesystem cache to
    // attempt a ~169M-element array allocation, crashing V8 with
    // "Fatal JavaScript invalid size error 169220804". Switch to memory cache.
    config.cache = { type: "memory" };
    return config;
  },
  /**
   * Define an (empty) Turbopack config so Next 16 doesn't complain about
   * having a webpack config without turbopack config.
   */
  turbopack: {},
};

export default nextConfig;
