import type { Metadata } from "next";
import type { ReactNode } from "react";
// RainbowKit's modal styles first, so the app sheets below win where they overlap.
import "@rainbow-me/rainbowkit/styles.css";
// The former globals.css split by area, in its original rule order: later sheets override earlier ones.
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/metrics.css";
import "@/styles/tree.css";
import "@/styles/details.css";
import "@/styles/footer.css";
import "@/styles/providers.css";
import "@/styles/activity.css";
import "@/styles/dialogs.css";
import "@/styles/responsive.css";
import "@/styles/palette.css";
import "@/styles/icons.css";
import "@/styles/backdrop.css";
import "@/styles/workspace.css";
import "@/styles/permissions.css";
import "@/styles/accent.css";
import "@/styles/provider-badges.css";
// Live features (Sepolia + relay), one sheet per feature area; loaded after the shell sheets.
import "@/styles/live-shell.css";
import "@/styles/live-primitives.css";
import "@/styles/live-members.css";
import "@/styles/live-sessions.css";
import "@/styles/live-agents.css";
import "@/styles/live-policies.css";
import "@/styles/live-setup.css";
import "@/styles/live-providers.css";

import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "Relay — Access, connected.",
  description: "Manage API permissions, budgets and agent sessions through an ENS permission tree.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700;800;900&family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
