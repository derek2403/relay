// GET /api/relay/credentials/nonce?address=0x… : a one-time nonce (5 minutes)
// and the exact EIP-4361 message the root owner signs to sign in.

import type { NextRequest } from "next/server";

import { credentialsDeps, getNonce } from "@/lib/relay/credentials-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return getNonce(request, credentialsDeps());
}
