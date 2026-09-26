// POST /api/relay/approvals/enroll/challenge {approver, name?}: message + World request to link a World ID to an approver wallet.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postEnrollChallenge } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postEnrollChallenge(request, approvalsDeps());
}
