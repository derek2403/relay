"use client";

import { RainbowKitProvider, type Theme, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";
import { sepolia } from "wagmi/chains";

import { config } from "@/lib/wagmi";

// RainbowKit's light theme in the khaki palette (styles/palette.css tokens).
const base = lightTheme({ accentColor: "#616440", accentColorForeground: "#eee7d7", borderRadius: "small", overlayBlur: "small" });
const khakiTheme: Theme = {
  ...base,
  colors: {
    ...base.colors,
    actionButtonSecondaryBackground: "#ded9cc",
    closeButton: "#36352e",
    closeButtonBackground: "#ded9cc",
    connectButtonBackground: "#e3dfd5",
    connectButtonInnerBackground: "#ded9cc",
    connectButtonText: "#36352e",
    generalBorder: "#b3a58d",
    generalBorderDim: "#49453a35",
    menuItemBackground: "#ded9cc",
    modalBackdrop: "rgba(54, 53, 46, 0.35)",
    modalBackground: "#e7e1d4",
    modalBorder: "#9f866a",
    modalText: "#36352e",
    modalTextDim: "#a29a89",
    modalTextSecondary: "#807a6c",
    profileAction: "#ded9cc",
    profileActionHover: "#d3cdbf",
    profileForeground: "#e3dfd5",
    selectedOptionBorder: "#616440",
  },
  fonts: { body: "'DM Sans', system-ui, sans-serif" },
  shadows: { ...base.shadows, dialog: "8px 8px 0 #745c3955", connectButton: "none" },
};

export function Providers({ children }: { children: React.ReactNode }) {
  // Pages refetch explicitly after each transaction; refetching every chain read
  // whenever the tab regains focus only burns the public RPC's rate limit.
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } }));
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={khakiTheme} modalSize="compact" initialChain={sepolia} appInfo={{ appName: "Relay" }}>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
