// GET /api/ens/owned?address=0x... : the names under RELAY_ROOT_NAME an
// address holds right now, deepest first. The CLI uses it to find "your"
// name from your key alone (ENSv2 has no owner -> names index, so the relay
// walks the company tree; see lib/relay/owned.ts).
//
// Chain data is public, so this needs no sign-in; the walk is cached for a
// few seconds and each client is rate limited.

import type { NextRequest } from "next/server";
import { getAddress, isAddress } from "viem";

import { isAdmin, jsonError } from "@/lib/relay/auth";
import { getConfig } from "@/lib/relay/config";
import { getChainReader } from "@/lib/relay/ens";
import { cachedTree, ownedIn } from "@/lib/relay/owned";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";
import type { OwnedResponse } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("address")?.trim();
  if (!raw) return jsonError(400, "missing address", "Add ?address=0x...");
  if (!isAddress(raw, { strict: false })) return jsonError(400, "invalid address", `"${raw}" is not an address`);
  const address = getAddress(raw);

  const config = getConfig();
  if (!config.rootName) return jsonError(503, "no root", config.rootError ?? "The relay has no root name (set RELAY_ROOT_NAME).");
  if (!isAdmin(request, { config }) && !relayLimits().owned.take(clientKey(request.headers))) {
    return jsonError(429, "too many requests", "Slow down and try again in a moment.", { "retry-after": "5" });
  }

  try {
    const scan = await cachedTree(getChainReader(config.rpcUrl, config.logsRpcUrl), config.rootName);
    const names = ownedIn(scan, address);
    if (!scan.complete && names.length === 0) {
      // Part of the tree is still being read (first scans of a registry take a while): nothing found yet isn't an answer.
      return jsonError(503, "still scanning", `The relay is still reading the ${config.rootName} tree. Try again in a few seconds.`, { "retry-after": "3" });
    }
    // `complete: false` means some branches weren't read yet, so the list may miss names.
    const body: OwnedResponse & { complete: boolean } = { address, names, complete: scan.complete };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(500, "failed", err instanceof Error ? err.message : String(err));
  }
}
