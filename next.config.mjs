const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // RainbowKit pulls in wagmi's Base Account connector; on the server that resolves
  // @base-org/account's Node build, which imports @coinbase/cdp-sdk and its optional
  // x402 peers (not installed). Loading cdp-sdk from node_modules at runtime instead of
  // bundling it keeps SSR compiling; the browser build never imports it.
  serverExternalPackages: ["@coinbase/cdp-sdk"],
  // Production builds use webpack (`next build --webpack`). RainbowKit 2.2's wallet barrel
  // also defines portoWallet and geminiWallet, which import `porto` and `gemini` from
  // wagmi/connectors; wagmi 3 no longer exports them. We never use those two wallets
  // (lib/wagmi.ts), so report the missing exports as warnings instead of failing the build.
  // Turbopack ignores this hook and already tolerates them; the empty turbopack entry tells
  // Next 16 that a Turbopack build (plain `next build`, e.g. scripts/demo-e2e.ts) is intended too.
  turbopack: {},
  webpack(config) {
    config.module.rules.push({
      test: /[\\/]node_modules[\\/]@rainbow-me[\\/]rainbowkit[\\/]dist[\\/]wallets[\\/]/,
      parser: { exportsPresence: "warn" },
    });
    return config;
  },
};
export default nextConfig;
