// POST /api/relay/approvals/enroll/unlink {address} then {challengeId, signature}: the company owner unlinks an approver's World ID.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postUnlink } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postUnlink(request, approvalsDeps());
}
