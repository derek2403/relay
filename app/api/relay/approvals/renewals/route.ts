// POST /api/relay/approvals/renewals (agent kr1 token) {subject, proposed, reason?}: 200 clear or 202 paused with an incident.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postRenewal } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postRenewal(request, approvalsDeps());
}
