// Codex through a login: `relay login` points Codex's base_url at /api/relay/codex/login/v1 and sends the
// login's secret as x-relay-login; the user signs in to Codex by typing their ENS name as the API key.
// Served as the login's agent, exactly like /api/relay/codex (lib/relay/codex-sessions.ts).

import type { NextRequest } from "next/server";

import { codexSessionDeps, handleCodexSessionRequest } from "@/lib/relay/codex-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  return handleCodexSessionRequest(request, codexSessionDeps());
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
