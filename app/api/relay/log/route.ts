// GET /api/relay/log?limit= : the relay's recent decisions, newest first.
// The admin sees everything; an agent token sees only its own names (and the
// names under it). Open to anyone only in development without RELAY_ADMIN_TOKEN.

import type { NextRequest } from "next/server";

import { canView, viewerFor } from "@/lib/relay/auth";
import { LOG_LIMIT } from "@/lib/relay/meter";
import { relayDeps } from "@/lib/relay/policy";
import { relayLimits } from "@/lib/relay/ratelimit";
import type { LogEntry } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const deps = relayDeps();
  const viewer = await viewerFor(request, deps, relayLimits());
  if (viewer instanceof Response) return viewer;
  const raw = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.floor(raw), 0), LOG_LIMIT) : 100;
  const entries: LogEntry[] =
    viewer.kind === "agent" ? deps.meter.recent(LOG_LIMIT).filter((e) => canView(viewer, e.name)).slice(0, limit) : deps.meter.recent(limit);
  return Response.json(entries, { headers: { "cache-control": "no-store" } });
}
