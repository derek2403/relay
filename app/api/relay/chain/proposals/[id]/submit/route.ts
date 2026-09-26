// POST /api/relay/chain/proposals/<id>/submit: recheck, reserve, sign with the relay signer and broadcast
// an approved proposal (token of the proposing agent or an ancestor agent).

import { handleSubmit } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return handleSubmit(request, id);
}
