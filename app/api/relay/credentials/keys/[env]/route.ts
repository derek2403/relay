// PUT /api/relay/credentials/keys/<ENV_NAME> {"value": "…" | null} stores (or
// clears) a key; DELETE clears it. Owner session or admin; cookie-authenticated
// requests must be same-origin with content-type: application/json.

import type { NextRequest } from "next/server";

import { credentialsDeps, writeKey } from "@/lib/relay/credentials-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ env: string }> };

export async function PUT(request: NextRequest, { params }: Context) {
  const { env } = await params;
  return writeKey(request, env, credentialsDeps(), false);
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const { env } = await params;
  return writeKey(request, env, credentialsDeps(), true);
}
