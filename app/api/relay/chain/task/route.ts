// POST /api/relay/chain/task {task, as?}: natural-language task -> typed plan -> checked execution -> report (agent token).

import { handleTask } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleTask(request);
