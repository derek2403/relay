// POST /api/relay/approvals/enroll/confirm {challengeId, signature, world}: links the verified World ID (nullifier) to the wallet, once.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postEnrollConfirm } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postEnrollConfirm(request, approvalsDeps());
}
