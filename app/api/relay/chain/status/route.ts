// GET /api/relay/chain/status: the blockchain workspace's live status for the Providers card (public, no secrets).

import { handleStatus } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handleStatus(request);
