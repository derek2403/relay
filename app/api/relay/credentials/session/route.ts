// POST /api/relay/credentials/session {address, message, signature} : signs the
// root owner in (HttpOnly relay_owner cookie, 12 h). {"action":"signout"} clears it.

import type { NextRequest } from "next/server";

import { credentialsDeps, postSession } from "@/lib/relay/credentials-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return postSession(request, credentialsDeps());
}
