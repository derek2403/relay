// POST /api/relay/approvals/confirm {challengeId, signature, world?}: verifies and applies a decision. Authenticated only by the wallet signature; agent and admin tokens are refused.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postConfirm } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postConfirm(request, approvalsDeps());
}
