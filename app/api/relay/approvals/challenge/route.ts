// POST /api/relay/approvals/challenge {subject, decision, approver, scope?}: the exact message an approver signs (plus the World request when World is required).

import { approvalsDeps } from "@/lib/relay/approvals";
import { postChallenge } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postChallenge(request, approvalsDeps());
}
