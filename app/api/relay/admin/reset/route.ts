// POST /api/relay/admin/reset : clears spend, counts, reservations and log
// entries of names that are no longer registered (for `npm run demo:reset`).
// Body (optional): {"names": ["derek.dev.eng.acme.eth", ...]} clears exactly
// those names instead, registered or not.
//
// Needs the admin (RELAY_ADMIN_TOKEN as Bearer, or the sign-in cookie). In
// development without RELAY_ADMIN_TOKEN, the automatic mode (no list) is open:
// it only clears spend and counts of names that can no longer spend anything,
// and never deletes log entries (the record of who was removed).

import type { NextRequest } from "next/server";

import { isAdmin, jsonError } from "@/lib/relay/auth";
import { relayDeps } from "@/lib/relay/policy";
import { clientKey, relayLimits } from "@/lib/relay/ratelimit";
import { resetMeter } from "@/lib/relay/reset";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const deps = relayDeps();
  const admin = isAdmin(request, deps);

  let names: string[] | undefined;
  const text = await request.text().catch(() => "");
  if (text.trim()) {
    let body: { names?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError(400, "bad request", 'Send no body, or JSON: {"names": ["<name>", ...]}');
    }
    if (body?.names !== undefined) {
      if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === "string") || body.names.length > 500) {
        return jsonError(400, "bad request", '"names" must be a list of up to 500 ENS names');
      }
      names = body.names;
    }
  }

  if (!admin) {
    const open = deps.config.viewAuth === "open" && names === undefined;
    if (!open) {
      return jsonError(401, "not signed in", deps.config.admin.enabled ? "Send RELAY_ADMIN_TOKEN as Authorization: Bearer." : "Set RELAY_ADMIN_TOKEN on the relay and send it as Authorization: Bearer.");
    }
    // Each name costs a chain read.
    if (!relayLimits().policy.take(clientKey(request.headers))) {
      return jsonError(429, "too many requests", "Slow down and try again in a moment.", { "retry-after": "5" });
    }
  }

  const result = await resetMeter(deps, names, { keepLog: !admin });
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
