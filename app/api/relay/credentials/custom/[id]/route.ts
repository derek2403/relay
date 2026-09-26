// PUT /api/relay/credentials/custom/<id> {"label"?, "value"?, "note"?} updates a
// credential-only service (value null or "" clears it); DELETE removes it.

import type { NextRequest } from "next/server";

import { credentialsDeps, writeCustom } from "@/lib/relay/credentials-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return writeCustom(request, id, credentialsDeps(), false);
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return writeCustom(request, id, credentialsDeps(), true);
}
