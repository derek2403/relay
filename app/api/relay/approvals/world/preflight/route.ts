// GET /api/relay/approvals/world/preflight: is World ID set up? Config problems, RP signing,
// the signer address and a fake-proof probe of the Portal (cached one minute). No secrets.

import { approvalsDeps } from "@/lib/relay/approvals";
import { getPreflight } from "@/lib/relay/approvals/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return getPreflight(approvalsDeps());
}
