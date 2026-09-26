// /api/relay/chain/proposals
//   POST {requestId, action}: prepare a proposal (agent token).
//   GET ?all=1 (public) or ?scope=mine|subtree (agent token): list proposals (archived ones only with &archived=1).

import { handleCreateProposal, handleListProposals } from "@/lib/chain/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleCreateProposal(request);
export const GET = (request: Request) => handleListProposals(request);
