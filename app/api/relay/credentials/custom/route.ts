// PUT /api/relay/credentials/custom {"label", "value"?, "note"?} : adds a
// credential-only service (stored encrypted, never routed by the relay).

import type { NextRequest } from "next/server";

import { createCustom, credentialsDeps } from "@/lib/relay/credentials-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest) {
  return createCustom(request, credentialsDeps());
}

export const POST = PUT;
