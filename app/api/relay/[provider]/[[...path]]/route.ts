// The relay: /api/relay/<provider>/<provider path>. Point a tool's base URL
// here (e.g. ANTHROPIC_BASE_URL=http://localhost:3000/api/relay/claude) and
// pass a Keyless Relay token where it expects an API key.

import type { NextRequest } from "next/server";

import { relayDeps } from "@/lib/relay/policy";
import { handleRelayRequest } from "@/lib/relay/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ provider: string; path?: string[] }> };

async function handle(request: NextRequest, { params }: Context) {
  const { provider } = await params;
  return handleRelayRequest(request, provider, relayDeps());
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
