// POST /api/relay/chain/events {contract, event?, limit?}: recent indexed events of a granted contract (agent token).

import { handleEvents } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleEvents(request);
