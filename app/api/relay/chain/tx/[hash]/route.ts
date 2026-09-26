// GET /api/relay/chain/tx/<hash>: a transaction's status and receipt (agent token; its subtree's or a granted contract's).

import { handleTx } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ hash: string }> };

export async function GET(request: Request, { params }: Context) {
  const { hash } = await params;
  return handleTx(request, hash);
}
