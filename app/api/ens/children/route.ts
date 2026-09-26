// GET /api/ens/children?name= : names registered directly under a name, with
// their state and bundle. Labels come from the subname registry's events,
// scanned incrementally and cached per registry.
//
// Chain data is public, so this needs no sign-in, but scans are expensive:
// only names under RELAY_ROOT_NAME are listed (any name while it is unset,
// during setup) and each client is rate limited. A listing is shared by every
// caller for a few seconds (one read in flight per name); those answers don't
// count against the limit, so a portal polling its tree stays cheap.

import type { NextRequest } from "next/server";

import { tryNormalize } from "@/lib/ens/names";
import { isAdmin, jsonError } from "@/lib/relay/auth";
import { applyDnsAlias, getConfig } from "@/lib/relay/config";
import { getChainReader, isChainReadError, isScanLimitError } from "@/lib/relay/ens";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";
import type { ChildrenResponse } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SHARED_MS = 5_000;
type Shared = { at: number; result: Promise<ChildrenResponse> };
const g = globalThis as unknown as { __relayChildren?: Map<string, Shared> };
const shared = () => (g.__relayChildren ??= new Map());

/** The listing for `name`: a fresh one (or the one in flight) from the last few seconds, else null. */
function recent(name: string, now: number): Promise<ChildrenResponse> | null {
  const hit = shared().get(name);
  return hit && now - hit.at < SHARED_MS ? hit.result : null;
}

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
  const now = Date.now();
  let pending = recent(name, now);
  if (!pending) {
    if (!isAdmin(request, { config }) && !relayLimits().children.take(clientKey(request.headers))) {
      return jsonError(429, "too many requests", "Slow down and try again in a moment.", { "retry-after": "5" });
    }
    pending = getChainReader(config.rpcUrl, config.logsRpcUrl).listChildren(name);
    const entry: Shared = { at: now, result: pending };
    shared().set(name, entry);
    // A failed read isn't shared: the next caller tries again.
    pending.catch(() => {
      if (shared().get(name) === entry) shared().delete(name);
    });
    if (shared().size > 500) for (const [k, v] of shared()) if (now - v.at >= SHARED_MS) shared().delete(k);
  }

  try {
    const result: ChildrenResponse = await pending;
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (isScanLimitError(err)) return jsonError(err.retryable ? 503 : 422, err.retryable ? "still scanning" : "too many subnames", err.message);
    if (isChainReadError(err)) return jsonError(502, "ENS read failed", err.message);
    return jsonError(500, "failed", err instanceof Error ? err.message : String(err));
  }
}
