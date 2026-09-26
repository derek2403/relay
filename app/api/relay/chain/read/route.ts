// POST /api/relay/chain/read {contract, method, args}: a view function of a granted contract (agent token).

import { handleRead } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleRead(request);
