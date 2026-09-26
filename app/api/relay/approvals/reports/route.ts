// POST /api/relay/approvals/reports (agent kr1 token) {subject, category, explanation}: stored as untrusted text; may pause a name below the reporter.

import { approvalsDeps } from "@/lib/relay/approvals";
import { postReport } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return postReport(request, approvalsDeps());
}
