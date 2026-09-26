// POST /api/fund {"name": "<member name>"} : tops up a member's wallet with a
// little Sepolia ETH from the relay's funder wallet (FUNDER_PRIVATE_KEY), so a
// new member can create agents without anyone sending gas by hand. No sign-in:
// the on-chain checks in lib/relay/fund.ts decide who gets funded.

import type { NextRequest } from "next/server";

import { handleFund, funderWallet } from "@/lib/relay/fund";
import { relayDeps } from "@/lib/relay/policy";
import { relayLimits } from "@/lib/relay/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const deps = relayDeps();
  return handleFund(request, { ...deps, wallet: funderWallet(deps.config), limits: relayLimits() });
}
