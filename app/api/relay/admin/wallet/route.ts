// /api/relay/admin/wallet : sign in as the relay admin with the wallet that owns the company root.
// GET ?address=0x… answers the one-time EIP-4361 message to sign (5 minutes); POST {address,
// message, signature} checks it and the on-chain owner, then sets the same admin cookie as the
// token sign-in at /api/relay/admin. Refused while RELAY_ADMIN_TOKEN is not set.

import type { NextRequest } from "next/server";

import { adminWalletDeps, getAdminChallenge, postAdminWallet } from "@/lib/relay/admin-wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return getAdminChallenge(request, adminWalletDeps());
}

export async function POST(request: NextRequest) {
  return postAdminWallet(request, adminWalletDeps());
}
