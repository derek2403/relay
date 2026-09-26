// GET /api/relay/approvals/incidents: every incident (no evidence) and the names paused right now. Public, like the tree.

import { approvalsDeps } from "@/lib/relay/approvals";
import { listIncidents } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return listIncidents(approvalsDeps());
}
