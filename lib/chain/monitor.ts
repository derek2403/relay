// Deterministic monitoring rules over token transfers. A finding is a rule
// match with the evidence and a templated explanation, never a verdict: the
// report says so ("a flag is a rule match, not proof of wrongdoing").

import { type Address, type Hex, getAddress, isAddress, isAddressEqual } from "viem";

import type { ChainWorkspace } from "./config";
import { type EffectiveGrant, formatAmount, parseAmount } from "./grant";

/** A transfer as the monitor sees it (Transfer / Paid / OwnerTransfer events, mapped by the caller). */
export type TransferLike = {
  txHash: Hex;
  block: number;
  logIndex?: number;
  from: Address;
  to: Address;
  /** Base units (bigint, or a decimal string as MultiBaas returns it). */
  amount: bigint | string;
  /** Event name, for the explanation. */
  event?: string;
};

export type FindingRule = "large" | "unapproved-recipient";
export type Severity = "high" | "medium";

export type Finding = {
  rule: FindingRule;
  severity: Severity;
  txHash: Hex;
  block: number;
  from: Address;
  to: Address;
  /** STD decimal string. */
  amount: string;
  explorerUrl: string;
  why: string;
};

/** The fixed caveat every monitoring report carries. */
export const FLAG_CAVEAT = "A flag is a rule match, not proof of wrongdoing.";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function toBase(amount: bigint | string): bigint | null {
  if (typeof amount === "bigint") return amount >= 0n ? amount : null;
  return typeof amount === "string" && /^\d{1,78}$/.test(amount) ? BigInt(amount) : null;
}

/**
 * Flags `large` (amount ≥ ws.monitor.largeTransfer) and `unapproved-recipient`
 * (outgoing from the vault to an address outside the workspace recipients and
 * the grant's recipients). Output is sorted by block, log index, tx, rule, and
 * de-duplicated; malformed transfers are skipped.
 */
export function flagTransfers(events: TransferLike[], ws: ChainWorkspace, eff: EffectiveGrant | null): Finding[] {
  const decimals = ws.token.decimals;
  const threshold = parseAmount(ws.monitor?.largeTransfer, decimals);
  const approved: Address[] = [
    ...Object.values(ws.recipients ?? {}).filter((a) => isAddress(a, { strict: false })).map((a) => getAddress(a)),
    ...(eff?.recipients ?? []),
  ];
  const explorer = ws.network.explorer.replace(/\/+$/, "");
  const findings: (Finding & { logIndex: number })[] = [];
  const seen = new Set<string>();

  for (const e of events) {
    if (!e || !isAddress(e.from, { strict: false }) || !isAddress(e.to, { strict: false }) || typeof e.txHash !== "string") continue;
    const amount = toBase(e.amount);
    if (amount === null) continue;
    const from = getAddress(e.from);
    const to = getAddress(e.to);
    const std = formatAmount(amount, decimals);
    const base = { txHash: e.txHash, block: e.block, from, to, amount: std, explorerUrl: `${explorer}/tx/${e.txHash}`, logIndex: e.logIndex ?? 0 };
    const what = `${e.event ?? "Transfer"} of ${std} ${ws.token.symbol} from ${isAddressEqual(from, ws.vault.address) ? "the vault" : short(from)} to ${short(to)} (block ${e.block})`;
    const push = (rule: FindingRule, severity: Severity, why: string) => {
      const key = `${e.txHash.toLowerCase()}:${base.logIndex}:${rule}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({ rule, severity, why, ...base });
    };

    if (threshold !== null && amount >= threshold)
      push("large", "medium", `${what} is at or above the ${ws.monitor.largeTransfer} ${ws.token.symbol} large-transfer threshold. ${FLAG_CAVEAT}`);
    if (isAddressEqual(from, ws.vault.address) && !approved.some((a) => isAddressEqual(a, to)))
      push("unapproved-recipient", "high", `${what}: ${short(to)} is not an approved recipient (not in the workspace's named recipients or this agent's grant). ${FLAG_CAVEAT}`);
  }

  findings.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex || a.txHash.localeCompare(b.txHash) || a.rule.localeCompare(b.rule));
  return findings.map(({ logIndex: _logIndex, ...f }) => f);
}
