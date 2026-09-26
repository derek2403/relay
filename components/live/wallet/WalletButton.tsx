"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";

/**
 * The sidebar wallet pill in live mode, driven by RainbowKit: "Connect wallet" opens the
 * connect modal, "Switch to Sepolia" the chain modal, and the name (its primary ENS name, else the
 * `name` it owns in the org) or short address the
 * account modal (copy, disconnect). Renders "Connect wallet", disabled, until mounted so
 * the server HTML and the first client pass match.
 */
export function WalletButton({ name }: { name?: string | null }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, authenticationStatus, mounted }) => {
        const ready = mounted && authenticationStatus !== "loading";
        const connected = ready && !!account && !!chain && (!authenticationStatus || authenticationStatus === "authenticated");
        const wrongChain = connected && !!chain?.unsupported;
        const label = !connected ? "Connect wallet" : wrongChain ? "Switch to Sepolia" : (account?.ensName ?? name ?? account?.displayName ?? "Wallet");
        const onClick = !connected ? openConnectModal : wrongChain ? openChainModal : openAccountModal;
        return (
          <button
            type="button"
            className={cx("wallet", "wallet-button", wrongChain && "wrong-chain")}
            onClick={onClick}
            disabled={!ready}
            title={connected && !wrongChain ? account?.address : undefined}
          >
            <Icon name="wallet" />
            <span>{label}</span>
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
