import type { Address } from "viem";

import { ENSV2_SEPOLIA } from "./deployments";

// Addresses of the ENSv2 Sepolia deployment, keyed by deployment name.
// Import ABIs individually from "@/lib/ens/abis/<Name>" to keep page bundles small.
function pluckAddresses<T extends Record<string, { address: Address }>>(deployments: T) {
  const out = {} as { [K in keyof T]: Address };
  for (const name in deployments) out[name] = deployments[name].address;
  return out;
}

export const addresses = pluckAddresses(ENSV2_SEPOLIA);

/**
 * The canonical Universal Resolver proxy. It has the same address on mainnet
 * and Sepolia, and viem's `sepolia` chain already targets it for getEns*
 * actions. Prefer it over the implementation address in `addresses`.
 *
 * On Sepolia (verified 2026-09-26) the chain is:
 *   UpgradableUniversalResolverProxy (0xeeee…) -> ManagedUniversalResolverProxy
 *   -> UniversalResolverV2 (root = RootRegistry)
 */
export const UNIVERSAL_RESOLVER_PROXY: Address = ENSV2_SEPOLIA.UpgradableUniversalResolverProxy.address;

/**
 * Registration fee tokens accepted by the Sepolia ETH Registrar. MockUSDC and
 * MockDAI have a permissionless `mint(address,uint256)`.
 */
export const PAYMENT_TOKENS = {
  MockUSDC: { address: ENSV2_SEPOLIA.MockUSDC.address, symbol: "USDC", decimals: 6, mintable: true },
  MockDAI: { address: ENSV2_SEPOLIA.MockDAI.address, symbol: "DAI", decimals: 18, mintable: true },
  CircleUSDC: {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
    symbol: "USDC",
    decimals: 6,
    mintable: false,
  },
} as const;

export const EXPLORER = "https://sepolia.etherscan.io";
export const explorerAddress = (a: string) => `${EXPLORER}/address/${a}`;
export const explorerTx = (h: string) => `${EXPLORER}/tx/${h}`;

/**
 * Integration test names from /web/ensv2-readiness. These expectations hold on
 * mainnet; on Sepolia `ur.integration-tests.eth` returns 0x1111… and
 * `test.offchaindemo.eth` returns null (checked 2026-09-26).
 */
export const MAINNET_TEST_NAMES = {
  universalResolver: { name: "ur.integration-tests.eth", expect: "0x2222222222222222222222222222222222222222" },
  ccipRead: { name: "test.offchaindemo.eth", expect: "0x779981590E7Ccc0CFAe8040Ce7151324747cDb97" },
} as const;
