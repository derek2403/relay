// Codex logins (lib/relay/codex-sessions.ts). `relay login` registers one, signed by the agent key:
//   POST   {agent, member, relay, secretHash, iat, exp, signature}
//   DELETE {relay, secretHash, iat, signature}   (relay logout)

import type { NextRequest } from "next/server";

import { codexSessionDeps, deleteCodexSession, postCodexSession } from "@/lib/relay/codex-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return postCodexSession(request, codexSessionDeps());
}

export async function DELETE(request: NextRequest) {
  return deleteCodexSession(request, codexSessionDeps());
}
