// GET /api/relay/approvals/approvers/<address>: whether that approver has linked a World ID, and when.

import { approvalsDeps } from "@/lib/relay/approvals";
import { getApprover } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ address: string }> };

export async function GET(_request: Request, { params }: Context) {
  const { address } = await params;
  return getApprover(address, approvalsDeps());
}
