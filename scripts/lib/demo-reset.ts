// npm run demo:reset helpers: flags, which MultiBaas links are relay escrows, how old the treasury
// seed history is, and the readiness checklist. Everything here is pure; scripts/demo-reset.ts
// reads and sends.

import { type Address, formatEther, isAddressEqual, parseEther } from "viem";

import type { MbAddress, MbEvent, MbPlan } from "../../lib/multibaas/types";
import { SIGNER_FUND_ETH, SIGNER_MIN_ETH } from "./chain-setup";

export class ResetArgsError extends Error {}

export type ResetArgs = {
  yes: boolean;
  keepHome: boolean;
  /** Show what would happen and the readiness checklist; change nothing. */
  plan: boolean;
  /** auto: only when the seed history is older than RESEED_AFTER_HOURS (or missing). */
  reseed: "auto" | "force" | "skip";
};

export const RESET_USAGE = `npm run demo:reset -- [--yes] [--keep-home] [--reseed | --no-reseed] [--plan]

  Sets up the next demo round: removes the names added under the teams, asks the relay to clear
  their spend and archive the round's chain proposals, task runs and incidents (and reset the
  allowance ledger), unlinks the relay's escrows from MultiBaas, re-emits the treasury seed history
  when it is older than 48 h, tops up the relay signer, deletes RELAY_HOME and what Codex made in
  demo-workspace/, then prints a readiness checklist.

  --yes        delete RELAY_HOME and the workspace files without asking
  --keep-home  leave RELAY_HOME
  --reseed     re-emit the treasury seed history now (npm run chain:setup -- --reseed)
  --no-reseed  never re-emit it
  --plan       print what would happen and the checklist; send and delete nothing (also --dry-run)

  Env: ADMIN_PRIVATE_KEY, RELAY_ADMIN_TOKEN, RELAY_URL (else RELAY_PUBLIC_URL), and from .env.local
  MULTIBAAS_URL, MULTIBAAS_API_KEY, FUNDER_PRIVATE_KEY, RELAY_ROOT_OWNER.`;

export function parseResetArgs(argv: string[]): ResetArgs & { help: boolean } {
  const out: ResetArgs & { help: boolean } = { yes: false, keepHome: false, plan: false, reseed: "auto", help: false };
  for (const a of argv) {
    if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--keep-home") out.keepHome = true;
    else if (a === "--plan" || a === "--dry-run") out.plan = true;
    else if (a === "--reseed") out.reseed = out.reseed === "skip" ? conflict() : "force";
    else if (a === "--no-reseed") out.reseed = out.reseed === "force" ? conflict() : "skip";
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new ResetArgsError(`Unknown option ${a}. Use --yes, --keep-home, --reseed, --no-reseed or --plan (--help lists them).`);
  }
  return out;
}

function conflict(): never {
  throw new ResetArgsError("--reseed and --no-reseed contradict each other");
}

// --- MultiBaas escrows ------------------------------------------------------------------------------

export const ESCROW_ALIAS = /^relay-escrow-\d+$/;
export const ESCROW_LABEL = "relay-escrow";
/** Workspace contracts that stay linked (the treasury monitor reads their events). */
export const KEEP_ALIASES = ["relay-token", "relay-vault"];

export type EscrowLink = { ref: string; address: Address; labels: string[] };

/**
 * The relay's escrow links to remove: addresses aliased relay-escrow-<n>, or linked to the
 * relay-escrow label, with at least one linked label. relay-token and relay-vault (by alias or by
 * the workspace's addresses in `keep`) are never included.
 */
export function escrowLinks(addresses: readonly MbAddress[], keep: readonly Address[] = []): EscrowLink[] {
  const out: EscrowLink[] = [];
  for (const a of addresses) {
    if (!a || typeof a.address !== "string") continue;
    const alias = typeof a.alias === "string" ? a.alias : "";
    if (KEEP_ALIASES.includes(alias) || keep.some((k) => isAddressEqual(k, a.address))) continue;
    const labels = (a.contracts ?? []).map((c) => c?.label).filter((l): l is string => typeof l === "string" && !!l);
    if (!labels.length) continue;
    if (!ESCROW_ALIAS.test(alias) && !labels.includes(ESCROW_LABEL)) continue;
    out.push({ ref: alias || a.address, address: a.address, labels: [...new Set(labels)] });
  }
  return out;
}

// --- Treasury seed history --------------------------------------------------------------------------

/** Re-emit the seed when the newest seeded transfer is older than this (MultiBaas keeps events 72 h). */
export const RESEED_AFTER_HOURS = 48;
export const OWNER_TRANSFER_SIG = "OwnerTransfer(address,uint256)";

/** The newest event's time (ms), or null when there is none with a readable time. */
export function newestEventMs(events: readonly MbEvent[]): number | null {
  let newest: number | null = null;
  for (const e of events) {
    const t = Date.parse(e?.triggeredAt ?? "");
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/** Whether to reseed: forced, skipped, or (auto) when there is no seed event or the newest is too old. */
export function shouldReseed(mode: ResetArgs["reseed"], newestMs: number | null, nowMs: number): boolean {
  if (mode !== "auto") return mode === "force";
  return newestMs === null || nowMs - newestMs > RESEED_AFTER_HOURS * 3600_000;
}

export const ageText = (newestMs: number | null, nowMs: number) => {
  if (newestMs === null) return "none found";
  const h = Math.max(0, (nowMs - newestMs) / 3600_000);
  return h < 1 ? `${Math.round(h * 60)} min old` : `${h.toFixed(1)} h old`;
};

// --- Relay signer gas -------------------------------------------------------------------------------

export const SIGNER_MIN_WEI = parseEther(SIGNER_MIN_ETH);
export const SIGNER_TOPUP_WEI = parseEther(SIGNER_FUND_ETH);
export const needsTopUp = (balanceWei: bigint) => balanceWei < SIGNER_MIN_WEI;
export const ethText = (wei: bigint) => `${Number(formatEther(wei)).toFixed(4)} ETH`;

// --- Plan limits ------------------------------------------------------------------------------------

/** Linked contracts used and allowed (limit null = unlimited); null when the plan doesn't list them. */
export function linkedSlots(plan: Pick<MbPlan, "limits">): { count: number; limit: number | null; free: number | null } | null {
  const l = plan.limits?.find((x) => x?.name === "linked_contracts");
  if (!l) return null;
  const count = l.count ?? 0;
  return { count, limit: l.limit ?? null, free: l.limit == null ? null : l.limit - count };
}

// --- Readiness ----------------------------------------------------------------------------------------

/** ok: true ✓, false ✗, null – (for information: doesn't block the round). */
export type Check = { ok: boolean | null; label: string; detail: string };

export const MIN_VAULT_STD = 50;
/** The member the demos add (Demo 1 step 3): must be absent before a round. */
export const demoMember = (root: string) => `derek.cloudops.dev.${root}`;

export const checkLine = (c: Check) => `  ${c.ok === true ? "✓" : c.ok === false ? "✗" : "–"} ${c.label}${c.detail ? `: ${c.detail}` : ""}`;

export const allReady = (checks: readonly Check[]) => checks.every((c) => c.ok !== false);

/** What a relay provider row says, for the checklist. */
export function providerCheck(label: string, providers: unknown, ids: string[]): Check {
  const rows = Array.isArray(providers) ? (providers as { id?: unknown; configured?: unknown }[]) : null;
  if (!rows) return { ok: null, label, detail: "relay status not read" };
  const missing = ids.filter((id) => !rows.some((r) => r?.id === id && r.configured === true));
  return missing.length ? { ok: false, label, detail: `${missing.join(", ")} not configured on the relay` } : { ok: true, label, detail: `${ids.join(", ")} configured` };
}
