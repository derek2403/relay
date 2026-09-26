// GET /api/relay/chain/proposals/<id>: one proposal (public); ?allowance=1 adds per-level allowance use.

import { handleGetProposal } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return handleGetProposal(request, id);
}
