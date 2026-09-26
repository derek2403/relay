// POST /api/relay/approvals/cancel {challengeId}: the approver closed the flow; the subject stays paused.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postCancel } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postCancel(request, approvalsDeps());
}
