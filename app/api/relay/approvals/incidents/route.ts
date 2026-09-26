// GET /api/relay/approvals/incidents: every incident (no evidence) and the names paused right now. Public, like the tree.
// Incidents an admin round reset archived are left out unless `?archived=1`.

import { approvalsDeps } from "@/lib/relay/approvals";
import { listIncidents } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const archived = new URL(request.url).searchParams.get("archived") === "1";
  return listIncidents(approvalsDeps(), { archived });
}
