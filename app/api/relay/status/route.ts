// GET /api/relay/status : how this relay is set up. Never exposes key values,
// only whether each catalog provider is configured (key present).

import { RECORD_PREFIX } from "@/lib/relay/bundle";
import { CATALOG, type Category, type ProviderId, countUnit } from "@/lib/relay/catalog";
import { relayDeps, rootWarning } from "@/lib/relay/policy";
import type { StatusResponse } from "@/lib/relay/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A provider row: the shared StatusResponse fields plus catalog details. */
type StatusProvider = StatusResponse["providers"][number] & {
  category: Category;
  /** A dollar cap (relay.cap.<id>) can be enforced for it. */
  dollarCaps: boolean;
  /** What a count limit (relay.max.<id>) counts. */
  countUnit: "requests" | "images";
  /** The variable the relay reads its key from (a name, never the value); null when none is needed. */
  keyEnv: string | null;
  note: string | null;
};

export async function GET() {
  const deps = relayDeps();
  const { config, meter } = deps;
  const providers: StatusProvider[] = CATALOG.map((p) => ({
    id: p.id as ProviderId,
    label: p.label,
    category: p.category,
    configured: config.isConfigured(p.id),
    metered: p.dollarCaps,
    dollarCaps: p.dollarCaps,
    countUnit: countUnit(p.id),
    keyEnv: p.keyEnv,
    note: "note" in p ? p.note : null,
  }));
  const status: StatusResponse & {
    providers: StatusProvider[];
    liveCheckSec: number | null;
    funder: { enabled: boolean; address: string | null; amountEth: string; error: string | null };
  } = {
    root: config.rootName,
    providers,
    recordPrefix: RECORD_PREFIX,
    dnsAlias: config.dnsAlias,
    requireCanonical: config.requireCanonical,
    baseUrl: `${config.publicUrl}/api/relay`,
    viewAuth: config.viewAuth,
    rootOwner: config.rootOwner,
    rootWarning: config.rootError ?? (await rootWarning(deps).catch(() => null)),
    maxTokenTtlSec: config.maxTokenTtlSec,
    meterError: meter.unavailable(),
    rejectedRequests: meter.rejectedCount,
    liveCheckSec: config.liveCheckMs === null ? null : config.liveCheckMs / 1000,
    funder: { enabled: config.funder.enabled, address: config.funder.address, amountEth: config.funder.amountEth, error: config.funder.error },
  };
  return Response.json(status, { headers: { "cache-control": "no-store" } });
}
