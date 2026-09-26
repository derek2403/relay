// GET /api/ens/children?name= : names registered directly under a name, with
// their state and bundle. Labels come from the subname registry's events,
// scanned incrementally and cached per registry.
//
// Chain data is public, so this needs no sign-in, but scans are expensive:
// only names under RELAY_ROOT_NAME are listed (any name while it is unset,
// during setup) and each client is rate limited.

import type { NextRequest } from "next/server";

import { tryNormalize } from "@/lib/ens/names";
import { isAdmin, jsonError } from "@/lib/relay/auth";
import { applyDnsAlias, getConfig } from "@/lib/relay/config";
import { getChainReader, isChainReadError, isScanLimitError } from "@/lib/relay/ens";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";
import type { ChildrenResponse } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("name")?.trim();
  if (!raw) return jsonError(400, "missing name", "Add ?name=<ENS name>");
  const normalized = tryNormalize(raw);
  if (!normalized) return jsonError(400, "invalid name", `"${raw}" is not a valid ENS name`);

  const config = getConfig();
  const name = applyDnsAlias(normalized, config.dnsAlias);
  const root = config.rootName;
  if (root && name !== root && !name.endsWith(`.${root}`)) {
    return jsonError(403, "outside the company", `This relay only lists names under ${root}.`);
  }
  if (!isAdmin(request, { config }) && !relayLimits().children.take(clientKey(request.headers))) {
    return jsonError(429, "too many requests", "Slow down and try again in a moment.", { "retry-after": "5" });
  }

  try {
    const result: ChildrenResponse = await getChainReader(config.rpcUrl, config.logsRpcUrl).listChildren(name);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (isScanLimitError(err)) return jsonError(err.retryable ? 503 : 422, err.retryable ? "still scanning" : "too many subnames", err.message);
    if (isChainReadError(err)) return jsonError(502, "ENS read failed", err.message);
    return jsonError(500, "failed", err instanceof Error ? err.message : String(err));
  }
}
