// GET /api/relay/policy?name=&provider= : what the relay would decide right
// now for a name, with every level's spend and counts (read-only, no owner
// check). `remaining` is the tightest dollar budget left, `remainingCount` the
// tightest count left (requests, or images).
// The admin can ask about any name; an agent token only about its own name
// and the names under it. Open to anyone only in development without
// RELAY_ADMIN_TOKEN.

import type { NextRequest } from "next/server";

import { tryNormalize } from "@/lib/ens/names";
import { canView, jsonError, viewerFor } from "@/lib/relay/auth";
import { applyDnsAlias } from "@/lib/relay/config";
import { isChainReadError } from "@/lib/relay/ens";
import { decide, relayDeps } from "@/lib/relay/policy";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";
import type { PolicyResponse } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const name = params.get("name")?.trim();
  const provider = params.get("provider")?.trim() || null;
  if (!name) return jsonError(400, "missing name", "Add ?name=<ENS name>");

  const deps = relayDeps();
  const limits = relayLimits();
  const viewer = await viewerFor(request, deps, limits);
  if (viewer instanceof Response) return viewer;
  const normalized = tryNormalize(name);
  if (viewer.kind === "agent" && !canView(viewer, normalized ? applyDnsAlias(normalized, deps.config.dnsAlias) : null)) {
    return jsonError(403, "not your name", `This token is for ${viewer.name}; it can only read that name and the names under it.`);
  }
  // Each answer costs chain reads (shared per block); the admin isn't limited.
  if (viewer.kind !== "admin" && !limits.policy.take(clientKey(request.headers))) {
    return jsonError(429, "too many requests", "Slow down and try again in a moment.", { "retry-after": "5" });
  }
  try {
    const d = await decide({ name, provider }, deps);
    const response: PolicyResponse & { remainingCount: number | null } = {
      name: d.name,
      provider: d.provider,
      root: d.root,
      allowed: d.allowed,
      reason: d.reason,
      remaining: d.remaining,
      remainingCount: d.remainingCount,
      levels: d.levels,
    };
    return Response.json(response, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(502, "ENS read failed", isChainReadError(err) ? err.message : "could not read ENS");
  }
}
