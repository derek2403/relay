// GET /api/relay/credentials : which service keys the relay holds (never the
// values). Anonymous callers see set / source / updatedAt; the signed-in root
// owner (relay_owner cookie) or the admin also get redacted hints.
// See docs/credentials-and-attestation.md.

import type { NextRequest } from "next/server";

import { credentialsDeps, getCredentials } from "@/lib/relay/credentials-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return getCredentials(request, credentialsDeps());
}
