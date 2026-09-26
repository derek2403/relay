import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  baseAccount,
  braveWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { sepolia } from "wagmi/chains";

// ENSv2 is deployed on Sepolia only. Set NEXT_PUBLIC_SEPOLIA_RPC_URL to use
// your own RPC (the public default is rate limited, and getLogs ranges are small).
export const RPC_URL = process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

// WalletConnect-based wallets need a WalletConnect Cloud project id. Without one the
// connect modal offers browser (injected) wallets only, so local use needs no setup.
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "";

const APP = { appName: "Relay", appDescription: "API access through ENS names.", projectId: WALLETCONNECT_PROJECT_ID };

const connectors = connectorsForWallets(
  WALLETCONNECT_PROJECT_ID
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, baseAccount] },
        { groupName: "More", wallets: [walletConnectWallet, braveWallet, injectedWallet] },
      ]
    : [{ groupName: "Browser wallets", wallets: [injectedWallet, rabbyWallet, braveWallet] }],
  APP,
);

export const config = createConfig({
  chains: [sepolia],
  connectors,
  transports: { [sepolia.id]: http(RPC_URL) },
  ssr: true,
});

export const CHAIN_ID = sepolia.id;

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
