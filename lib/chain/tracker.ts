// Follows submitted transactions to a final state: Submitted → Included →
// Confirmed (or Failed), through MultiBaas receipts.
//
// - A receipt appears → `included` (block, block hash, status).
// - At 2 confirmations (head - block + 1 ≥ 2) the block is read again: the
//   same hash → `confirmed` (the allowance reservation is committed) or
//   `failed` when the tx reverted (released). A different hash is a reorg:
//   back to `submitted`, and the next receipt decides again.
// - `uncertain` (the broadcast's outcome was unknown) and a stale `submitting`
//   (a crash between signing and recording the broadcast) are resolved only by
//   looking up the locally computed hash: found → submitted/included. Neither is
//   ever re-sent.
// - A signed tx stays valid until its nonce is used, so "dropped" (`failed`,
//   reservation released) needs proof that it can no longer be mined: after 10
//   minutes with no receipt and no trace, the signer's nonce on chain must be
//   past the tx's nonce. Until then the reservation stays held.
// - A confirmed deploy records the escrow, gives it a MultiBaas alias and links
//   it to the approved template from its deploy block.
//
// MultiBaas's free plan allows 30k API calls a month, so the poller runs only
// while something is pending (every 12 s) and stops when nothing is.

import { type Hex } from "viem";

import type { MultiBaas } from "../multibaas/client";
import { MultiBaasError, summarizeReceipt } from "../multibaas/client";
import type { Meter } from "../relay/meter";
import type { ChainWorkspace } from "./config";
import { formatAmount } from "./grant";
import { PENDING, type Proposal, type ProposalState, transition } from "./proposals";
import type { ChainStore } from "./store";

/** Confirmations before a tx counts as final. */
export const CONFIRMATIONS = 2;
/** Poll interval while anything is pending. */
export const POLL_MS = 12_000;
/** A submitted/uncertain tx with no receipt and no trace after this long is checked for being dropped. */
export const DROP_AFTER_SEC = 10 * 60;
/** A `submitting` proposal younger than this is still being broadcast by its submit call: left alone. */
export const SUBMITTING_GRACE_SEC = 60;

/** What the tracker needs. */
export type TrackerDeps = {
  mb: MultiBaas;
  store: ChainStore;
  workspace: () => ChainWorkspace | null;
  relay: { meter: Meter };
  nowSec?: () => number;
};

const nowOf = (deps: Pick<TrackerDeps, "nowSec">) => deps.nowSec?.() ?? Math.floor(Date.now() / 1000);

/** Writes a proposal state change to the relay's activity log. */
export function logProposal(deps: Pick<TrackerDeps, "relay">, p: Proposal, detail: string, allowed = true) {
  deps.relay.meter.log({
    ts: Date.now(),
    name: p.agent.name,
    provider: "multibaas",
    method: "POST",
    path: `/chain/proposals/${p.id}`,
    allowed,
    reason: `${p.id} ${p.state}: ${detail}`.slice(0, 500),
    status: null,
    costUsd: null,
    estimated: false,
    signer: null,
  });
}

/** Releases (or commits) the proposal's allowance reservation, if it has one. */
function settleReservation(deps: TrackerDeps, p: Proposal, how: "commit" | "release") {
  const ws = deps.workspace();
  if (!p.reservationId || !ws) return;
  const ledger = deps.store.ledger(ws.token.address);
  if (how === "commit") ledger.commit(p.reservationId);
  else ledger.release(p.reservationId);
}

/** Moves a proposal through `steps` (each a legal transition) in one store update and logs each. */
function move(deps: TrackerDeps, p: Proposal, steps: { to: ProposalState; detail: string; patch?: Partial<Proposal> }[]): Proposal {
  const at = nowOf(deps);
  const next = deps.store.updateProposal(p.id, (cur) => {
    let x = cur;
    for (const s of steps) x = transition(x, s.to, s.detail, at, s.patch ?? {});
    return x;
  });
  for (const s of steps) logProposal(deps, { ...next, state: s.to }, s.detail);
  return next;
}

export type TrackResult = { pending: number; changed: string[]; errors: string[] };

/**
 * One pass over every pending proposal. Returns how many are still pending
 * afterwards. Never throws for MultiBaas trouble (it is reported in `errors`
 * and the proposal is left as it was, to try again next pass).
 */
export async function trackOnce(deps: TrackerDeps): Promise<TrackResult> {
  const out: TrackResult = { pending: 0, changed: [], errors: [] };
  if (deps.store.unavailable()) {
    out.errors.push(deps.store.unavailable()!);
    return out;
  }
  const pending = deps.store.proposals((p) => PENDING.includes(p.state) && !!p.submit?.hash);
  if (!pending.length) return out;

  let head: number;
  try {
    head = (await deps.mb.status()).blockNumber;
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e));
    out.pending = pending.length;
    return out;
  }

  for (const p0 of pending) {
    try {
      const changed = await trackOne(deps, p0, head);
      if (changed) out.changed.push(p0.id);
    } catch (e) {
      out.errors.push(`${p0.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  out.pending = deps.store.proposals((p) => PENDING.includes(p.state) && !!p.submit?.hash).length;
  return out;
}

async function trackOne(deps: TrackerDeps, p: Proposal, head: number): Promise<boolean> {
  const hash = p.submit!.hash;
  const now = nowOf(deps);
  const age = now - (p.submit?.at ?? p.createdAt);
  // A fresh `submitting` belongs to the submit call still broadcasting it.
  if (p.state === "submitting" && age < SUBMITTING_GRACE_SEC) return false;
  const raw = await deps.mb.receipt(hash);

  if (!raw) {
    if (p.state === "included") {
      // The block that held it is gone: a reorg. Wait for the tx to be mined again.
      move(deps, p, [{ to: "submitted", detail: `reorg: block ${p.receipt?.blockNumber} no longer holds ${hash.slice(0, 10)}…; waiting again`, patch: { receipt: undefined } }]);
      return true;
    }
    // submitting, submitted or uncertain with no receipt yet.
    const unsure = p.state === "uncertain" || p.state === "submitting";
    if (unsure || age >= DROP_AFTER_SEC) {
      const seen = await deps.mb.tx(hash);
      if (seen) {
        if (unsure) {
          move(deps, p, [{ to: "submitted", detail: `broadcast confirmed: ${hash.slice(0, 10)}… is known to the network`, patch: { error: undefined } }]);
          return true;
        }
        return false;
      }
      if (age >= DROP_AFTER_SEC) {
        // No trace, but the signed tx can still be mined until its nonce is used by another tx.
        const used = await nonceUsed(deps, p);
        if (!used) return false;
        // Its nonce is taken: re-check the receipt (it may have been mined just now) before calling it dropped.
        if (await deps.mb.receipt(hash)) return false;
        const next = move(deps, p, [
          { to: "failed", detail: `dropped: no receipt and no trace of ${hash.slice(0, 10)}… after ${Math.round(age / 60)} minutes, and the signer's nonce ${p.tx?.nonce} is used by another transaction`, patch: { error: "dropped" } },
        ]);
        settleReservation(deps, next, "release");
        return true;
      }
    }
    return false;
  }

  const r = summarizeReceipt(raw);
  if (r.hash !== hash.toLowerCase()) throw new Error(`receipt is for ${r.hash}, not ${hash}`);
  const confirmations = Math.max(0, head - r.blockNumber + 1);
  const receipt: NonNullable<Proposal["receipt"]> = {
    blockNumber: r.blockNumber,
    blockHash: r.blockHash,
    status: r.status,
    confirmations,
    ...(r.contractAddress ? { contractAddress: r.contractAddress } : {}),
  };

  const steps: { to: ProposalState; detail: string; patch?: Partial<Proposal> }[] = [];
  let state = p.state;
  if (state === "included" && p.receipt && p.receipt.blockHash.toLowerCase() !== r.blockHash.toLowerCase()) {
    steps.push({ to: "submitted", detail: `reorg: moved from block ${p.receipt.blockNumber} to ${r.blockNumber}` });
    state = "submitted";
  }
  if (state === "submitting") {
    steps.push({ to: "submitted", detail: `broadcast confirmed: ${hash.slice(0, 10)}… has a receipt` });
    state = "submitted";
  }
  if (state === "submitted" || state === "uncertain") {
    steps.push({ to: "included", detail: `included in block ${r.blockNumber}${r.status === "reverted" ? " (reverted)" : ""}`, patch: { receipt, error: undefined } });
    state = "included";
  }

  if (confirmations >= CONFIRMATIONS) {
    const block = await deps.mb.block(r.blockNumber);
    if (block.hash.toLowerCase() !== r.blockHash.toLowerCase()) {
      // The receipt's block isn't canonical any more.
      if (state === "included") steps.push({ to: "submitted", detail: `reorg: block ${r.blockNumber} is now ${block.hash.slice(0, 10)}…; waiting again`, patch: { receipt: undefined } });
    } else if (r.status === "success") {
      steps.push({ to: "confirmed", detail: `confirmed in block ${r.blockNumber} (${confirmations} confirmations)`, patch: { receipt } });
    } else {
      steps.push({ to: "failed", detail: `reverted in block ${r.blockNumber}`, patch: { receipt, error: "reverted" } });
    }
  } else if (!steps.length && p.receipt && p.receipt.confirmations !== confirmations) {
    // Still included: refresh the confirmation count silently.
    deps.store.updateProposal(p.id, (cur) => ({ ...cur, receipt: { ...receipt } }));
    return false;
  }

  if (!steps.length) return false;
  const next = move(deps, p, steps);
  if (next.state === "confirmed") {
    settleReservation(deps, next, "commit");
    if (next.op === "deploy") await recordEscrow(deps, next);
  } else if (next.state === "failed") settleReservation(deps, next, "release");
  return true;
}

/**
 * Whether the relay signer's next nonce on chain is past this proposal's tx
 * nonce (so the signed tx can never be mined). False when unknown.
 */
async function nonceUsed(deps: TrackerDeps, p: Proposal): Promise<boolean> {
  const ws = deps.workspace();
  const txNonce = p.tx?.nonce;
  if (!ws || typeof txNonce !== "number") return false;
  const a = await deps.mb.getAddress(ws.signer, ["nonce"]);
  const onChain = a?.nonce;
  return typeof onChain === "number" && Number.isSafeInteger(onChain) && onChain > txNonce;
}

/** Records a confirmed escrow deploy and links it in MultiBaas (best effort: failures are logged). */
export async function recordEscrow(deps: TrackerDeps, p: Proposal) {
  const ws = deps.workspace();
  const address = p.receipt?.contractAddress;
  if (!ws || !address || !p.submit) return;
  const [, payer, payee, amount, admin] = p.args as string[];
  void payer;
  const entry = deps.store.addEscrow({
    address,
    deployedBy: p.agent.name,
    proposalId: p.id,
    admin: admin as `0x${string}`,
    payee: payee as `0x${string}`,
    amount: /^\d+$/.test(String(amount)) ? formatAmount(BigInt(amount), ws.token.decimals) : String(amount),
    txHash: p.submit.hash,
    block: p.receipt!.blockNumber,
  });
  const alias = entry.alias!;
  try {
    await deps.mb.setAlias(address, alias);
    await deps.mb.link(alias, { label: ws.templates.escrow.label, version: ws.templates.escrow.version, startingBlock: String(p.receipt!.blockNumber) });
    logProposal(deps, p, `escrow ${address} linked in MultiBaas as ${alias}`);
  } catch (e) {
    const why = e instanceof MultiBaasError ? e.message : e instanceof Error ? e.message : String(e);
    logProposal(deps, p, `escrow ${address} deployed; MultiBaas link failed: ${why}`, false);
  }
}

// --- The in-process poller -------------------------------------------------------------------

type PollerState = { timer: ReturnType<typeof setInterval> | null; running: boolean; deps: TrackerDeps | null; last: TrackResult | null };
const g = globalThis as unknown as { __relayChainTracker?: PollerState };
const poller = (): PollerState => (g.__relayChainTracker ??= { timer: null, running: false, deps: null, last: null });

async function tick() {
  const s = poller();
  if (s.running || !s.deps) return;
  s.running = true;
  try {
    s.last = await trackOnce(s.deps);
    if (s.last.pending === 0 && !s.last.errors.length) stopTracking();
  } catch {
    // trackOnce reports its own errors; keep polling.
  } finally {
    s.running = false;
  }
}

/** Starts polling (if not already) while anything is pending. Safe to call often. */
export function ensureTracking(deps: TrackerDeps, intervalMs = POLL_MS) {
  const s = poller();
  s.deps = deps;
  if (s.timer) return;
  try {
    if (deps.store.unavailable() || !deps.store.proposals((p) => PENDING.includes(p.state)).length) return;
  } catch {
    return;
  }
  s.timer = setInterval(() => void tick(), intervalMs);
  s.timer.unref?.();
}

/** Stops the poller. */
export function stopTracking() {
  const s = poller();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
}

/** Whether the poller is running, and its last pass (status/debug). */
export const trackerState = () => ({ running: !!poller().timer, last: poller().last });

/** Hashes the tracker is waiting on (for the status card). */
export const pendingHashes = (store: ChainStore): Hex[] =>
  store.proposals((p) => PENDING.includes(p.state) && !!p.submit?.hash).map((p) => p.submit!.hash);
