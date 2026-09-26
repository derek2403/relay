// GET /api/relay/approvals/incidents/<id>: the full incident record. Agent text is labeled unverified.

import { approvalsDeps } from "@/lib/relay/approvals";
import { getIncident } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  return getIncident(id, approvalsDeps());
}
