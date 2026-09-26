// POST /api/relay/admin/reset : clears spend, counts, reservations and log
// entries of names that are no longer registered (for `npm run demo:reset`).
// Body (optional): {"names": ["derek.dev.eng.acme.eth", ...]} clears exactly
// those names instead, registered or not. {"chain": true} also resets the
// round's chain and approvals state (lib/chain/reset.ts): archives settled
// proposals, task runs and incidents (and the open ones of removed names),
// resets the allowance ledger (never an in-flight reservation) and lifts
// suspensions and overlays of removed names.
//
// Needs the admin (RELAY_ADMIN_TOKEN as Bearer, or the sign-in cookie). In
// development without RELAY_ADMIN_TOKEN, the automatic mode (no list, no
// chain) is open: it only clears spend and counts of names that can no longer
// spend anything, and never deletes log entries (the record of who was
// removed). `chain` always needs the admin.

import type { NextRequest } from "next/server";

import { resetChainRound } from "@/lib/chain/reset";
import { chainStore } from "@/lib/chain/store";
import { getApprovalsStore } from "@/lib/relay/approvals/store";
import { isAdmin, jsonError } from "@/lib/relay/auth";
import { relayDeps } from "@/lib/relay/policy";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";
import { resetMeter } from "@/lib/relay/reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const USAGE = 'Send no body, or JSON: {"names": ["<name>", ...], "chain": true}';

export async function POST(request: NextRequest) {
  const deps = relayDeps();
  const admin = isAdmin(request, deps);

  let names: string[] | undefined;
  let chain = false;
  const text = await request.text().catch(() => "");
  if (text.trim()) {
    let body: { names?: unknown; chain?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError(400, "bad request", USAGE);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError(400, "bad request", USAGE);
    if (body.names !== undefined) {
      if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === "string") || body.names.length > 500) {
        return jsonError(400, "bad request", '"names" must be a list of up to 500 ENS names');
      }
      names = body.names;
    }
    if (body.chain !== undefined) {
      if (typeof body.chain !== "boolean") return jsonError(400, "bad request", '"chain" must be true or false');
      chain = body.chain;
    }
  }

  if (!admin) {
    const open = deps.config.viewAuth === "open" && names === undefined && !chain;
    if (!open) {
      return jsonError(401, "not signed in", deps.config.admin.enabled ? "Send RELAY_ADMIN_TOKEN as Authorization: Bearer." : "Set RELAY_ADMIN_TOKEN on the relay and send it as Authorization: Bearer.");
    }
    // Each name costs a chain read.
    if (!relayLimits().policy.take(clientKey(request.headers))) {
      return jsonError(429, "too many requests", "Slow down and try again in a moment.", { "retry-after": "5" });
    }
  }

  // The chain reset must be able to save both stores; check before clearing anything.
  const chainState = chain ? chainStore() : null;
  const approvals = chain ? getApprovalsStore(deps.config.dataDir) : null;
  const down = chainState?.unavailable() ?? approvals?.unavailable() ?? null;
  if (down) return jsonError(503, "store unavailable", down);

  const result = await resetMeter(deps, names, { keepLog: !admin });
  if (!chainState || !approvals) return Response.json(result, { headers: { "cache-control": "no-store" } });
  try {
    const chainResult = await resetChainRound({ chain: chainState, approvals, reader: deps.reader, root: deps.config.rootName });
    return Response.json({ ...result, chain: chainResult }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonError(503, "chain reset failed", err instanceof Error ? err.message.slice(0, 300) : String(err));
  }
}
