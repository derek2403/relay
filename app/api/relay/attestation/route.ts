// GET /api/relay/attestation?nonce=<hex, optional> : a TDX quote from dstack
// (Phala's simulator when DSTACK_SIMULATOR_ENDPOINT is set) whose REPORTDATA is
// sha256(statement) ‖ nonce. 503 {reason: "no-tee"} when dstack isn't reachable.
// See docs/credentials-and-attestation.md.

import type { NextRequest } from "next/server";

import { attestationDeps, handleAttestation } from "@/lib/relay/attestation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleAttestation(request, attestationDeps());
}
