// The typed chain tools, executed for one authenticated agent: read, events,
// tx lookup, prepare (a proposal) and submit. Every write goes through the
// same steps, in this order, and nothing is signed unless all of them pass:
//
//   1. ENS policy for the agent (decide: registration, expiry, revocation
//      cascade, relay.keys containing "multibaas", suspensions) and its
//      effective blockchain grant (every level's relay.chain, intersected).
//   2. Deterministic validation of the typed action (validate.ts): capability,
//      network, contract, method, ABI args AND what they mean (recipient,
//      amount, gas, constructor constraints). A refused write is stored as a
//      `blocked` proposal naming the rule, before MultiBaas is called.
//   3. MultiBaas prepares the unsigned tx (from = the relay signer); the relay
//      signs only the calldata it validated itself.
//   4. Approval (a human's wallet signature over the proposal digest) when the
//      grant's rule requires it.
//   5. At submit: all of 1–2 again with fresh chain data, the approval bound to
//      this digest, the allowance reserved at every level atomically, then
//      sign, record the hash, broadcast. An unknown broadcast outcome is
//      `uncertain` and only the tracker resolves it; nothing is re-sent.
//
// The approvals module (lib/relay/approvals) marks proposals approved or
// rejected through the hooks registered here.

import { randomBytes } from "node:crypto";

import { type Address, type Hex, getAddress, isAddress, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { namehash } from "../ens/names";
import type { MultiBaas, MbEvent, MbTx } from "../multibaas/client";
import { MultiBaasError, signMbTx, summarizeReceipt } from "../multibaas/client";
import { hooks, type ProposalApproval as HookApproval, type ProposalView } from "../relay/approvals/hooks";
import { getConfig } from "../relay/config";
import { isChainReadError } from "../relay/ens";
import { memberLevelIndex } from "../relay/guard";
import { getMeter, type Meter } from "../relay/meter";
import { type PolicyDecision, decide } from "../relay/policy";
import type { RelayDeps } from "../relay/providers";
import type { LevelView } from "../relay/types";
import { CHAIN_ARTIFACTS } from "./artifacts";
import { type ChainWorkspace, explorerTx, recipientName } from "./config";
import { type EffectiveResult, type GrantLevel, approvalRequirement, effectiveGrant, formatAmount, shortGrantId } from "./grant";
import type { LedgerLevel } from "./ledger";
import { type Proposal, type ProposalState, approve, createProposal, expireIfDue, isDue, submitGate, transition, validRequestId } from "./proposals";
import { type ChainStore, ChainStoreError, chainStore } from "./store";
import { type TrackerDeps, ensureTracking, logProposal } from "./tracker";
import { type ChainAction, type NormalizedAction, type ResolvedContract, type ValidateContext, checkGas, escrowInBranch, inSubtree, requireCap, validateAction } from "./validate";

/** Everything the chain runtime needs (production: chainDeps() in service.ts). */
export type ChainDeps = TrackerDeps & {
  relay: RelayDeps;
  mb: MultiBaas;
  store: ChainStore;
  workspace: () => ChainWorkspace | null;
  /** The relay signer's private key (MULTIBAAS_SIGNER_PRIVATE_KEY), read at submit time. */
  signerKey: () => Hex | null;
  nowSec?: () => number;
  artifacts?: ValidateContext["artifacts"];
  /** Called after a broadcast; default starts the shared poller. null: no poller (tests call trackOnce). */
  track?: (() => void) | null;
  /** Planner settings (planner.ts). */
  planner?: { model?: string; reportModel?: string };
};

/** A refusal: HTTP status, error code, reason, and the rule when validation refused it. */
export type Refusal = {
  ok: false;
  status: number;
  error: string;
  reason: string;
  rule?: string;
  proposal?: Proposal;
  /** True when the caller had already shown it owns a live name (the refusal is logged). */
  proven?: boolean;
};
export type Ok<T> = { ok: true; status?: number; body: T };
export type OpResult<T> = Ok<T> | Refusal;

export const refusal = (status: number, error: string, reason: string, extra: Partial<Refusal> = {}): Refusal => ({ ok: false, status, error, reason, ...extra });

/** One authenticated agent with its fresh ENS decision and effective blockchain grant. */
export type AgentContext = {
  name: string;
  /** The token's signer (null when acting for a descendant or an ancestor's proposal). */
  signer: Address | null;
  /** The caller's kr1 token (the planner calls the relay's LLM route with it). */
  token: string | null;
  decision: PolicyDecision;
  leaf: LevelView;
  node: Hex;
  levels: GrantLevel[];
  eff: EffectiveResult;
  ws: ChainWorkspace;
  /** Owners of the human levels above the agent: allowed escrow admins. */
  admins: Address[];
  /** The member (human) level the agent hangs under: escrows deployed outside it don't resolve. */
  branch: string | null;
};

export const nowOf = (deps: Pick<ChainDeps, "nowSec">) => deps.nowSec?.() ?? Math.floor(Date.now() / 1000);

/** A level as the grant layer reads it. */
export const grantLevel = (l: LevelView): GrantLevel => ({ name: l.name, node: namehash(l.name), resource: l.resource, resolver: l.resolver, chain: l.chain ?? null });

/** Owners of the member level and the company levels above it (never the relay signer). */
export function humanOwners(levels: LevelView[], rootOwner: Address | null, signer: Address | null): Address[] {
  const member = memberLevelIndex(levels, rootOwner);
  const upTo = member < 0 ? levels.length - 1 : member;
  const out: Address[] = [];
  for (const l of levels.slice(0, upTo + 1)) {
    if (!l.owner || (signer && isAddressEqual(l.owner, signer))) continue;
    if (!out.some((a) => isAddressEqual(a, l.owner!))) out.push(getAddress(l.owner));
  }
  return out;
}

/** Writes one chain tool request to the activity log (allowed or refused). */
export function logOp(
  meter: Meter,
  e: { name: string | null; signer: Address | null; op: string; allowed: boolean; reason: string | null; status?: number | null; method?: string },
) {
  meter.log({
    ts: Date.now(),
    name: e.name,
    provider: "multibaas",
    method: e.method ?? "POST",
    path: `/chain/${e.op}`,
    allowed: e.allowed,
    reason: e.reason ? e.reason.slice(0, 500) : null,
    status: e.status ?? null,
    costUsd: null,
    estimated: false,
    signer: e.signer,
  });
}

/** A refusal's log text: the rule and short grant id first, so the activity list names them. */
export const refusalText = (r: Pick<Refusal, "rule" | "reason" | "error">, grantId?: Hex | null) =>
  `${r.rule ? `rule ${r.rule}` : r.error}${grantId ? ` (grant ${shortGrantId(grantId)})` : ""}: ${r.reason}`;

/**
 * The ENS decision and effective grant for `name`. With `signer`, the leaf
 * must be owned by it (a token's own name); without, the caller has already
 * proven it owns an ancestor (acting for a descendant or an ancestor's submit).
 */
export async function agentContext(deps: ChainDeps, name: string, signer: Address | null, token: string | null): Promise<AgentContext | Refusal> {
  let decision: PolicyDecision;
  try {
    decision = await decide({ name, provider: "multibaas", signer }, deps.relay);
  } catch (err) {
    return refusal(502, "ENS read failed", isChainReadError(err) ? err.message : "could not read ENS");
  }
  if (decision.denial !== null || !decision.allowed) {
    const reason = decision.reason ?? "denied";
    switch (decision.denial) {
      case "not-owner":
        return refusal(401, "not the owner", reason);
      case "not-registered":
        return refusal(403, "access revoked", reason);
      case "root-mismatch":
        return refusal(503, "root owner changed", reason);
      case "paused":
        return refusal(403, "paused", reason, { proven: true });
      case "policy":
        return refusal(403, "denied", reason, { proven: true });
      default:
        return refusal(403, "denied", reason);
    }
  }
  const ws = deps.workspace();
  if (!ws) return refusal(503, "chain_not_configured", "the relay has no blockchain workspace (org/chain.json); run npm run chain:setup", { proven: true });
  const down = deps.store.unavailable();
  if (down) return refusal(503, "chain_store_unavailable", down, { proven: true });
  const levels = decision.levels.map(grantLevel);
  const eff = effectiveGrant(levels, decision.overlays, ws, nowOf(deps));
  const leaf = decision.levels[decision.levels.length - 1];
  return {
    name: decision.name,
    signer,
    token,
    decision,
    leaf,
    node: namehash(decision.name),
    levels,
    eff,
    ws,
    admins: humanOwners(decision.levels, deps.relay.config.rootOwner, ws.signer),
    branch: branchOf(decision.levels, deps.relay.config.rootOwner),
  };
}

/** The member level's name (the human branch an agent hangs under); the leaf when no level is a member's. */
export function branchOf(levels: LevelView[], rootOwner: Address | null): string | null {
  const member = memberLevelIndex(levels, rootOwner);
  return member >= 0 ? levels[member].name : (levels[levels.length - 1]?.name ?? null);
}

/** Relay-deployed escrows this agent's branch may use. */
export const branchEscrows = (deps: Pick<ChainDeps, "store">, ctx: Pick<AgentContext, "branch" | "admins">) => deps.store.escrows().filter((e) => escrowInBranch(e, ctx));

const isRefusal = (x: unknown): x is Refusal => !!x && typeof x === "object" && (x as Refusal).ok === false;
export { isRefusal };

export { inSubtree };

const validateCtx = (deps: ChainDeps, ctx: AgentContext): ValidateContext => ({ admins: ctx.admins, branch: ctx.branch, ...(deps.artifacts ? { artifacts: deps.artifacts } : {}) });

const denyValidation = (ctx: AgentContext, v: { rule: string; reason: string }) =>
  refusal(v.rule === "grant" || v.rule.startsWith("cap:") ? 403 : 422, "blocked", v.reason, { rule: v.rule });

// --- Untrusted text ------------------------------------------------------------------------

/** Contract strings and event fields as plain data: no control characters, bounded length. */
export function cleanValue(v: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (typeof v === "string") return v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").slice(0, 200);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => cleanValue(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) out[String(cleanValue(k, depth + 1))] = cleanValue(x, depth + 1);
    return out;
  }
  return String(v).slice(0, 200);
}

// --- Read tools ----------------------------------------------------------------------------

const mbReason = (e: unknown) => (e instanceof MultiBaasError ? e.message : e instanceof Error ? e.message : String(e)).slice(0, 300);
const mbRefusal = (e: unknown) => refusal(502, "multibaas_error", mbReason(e));

export type ReadOutput = { contract: ResolvedContract; method: string; args: unknown[]; output: unknown };

/** read: a view/pure function of a granted contract. */
export async function readOp(deps: ChainDeps, ctx: AgentContext, action: ChainAction): Promise<OpResult<ReadOutput>> {
  if (action?.op !== "read") return refusal(400, "bad_request", "expected a read action");
  const v = validateAction(action, ctx.eff.grant, ctx.ws, deps.store.escrows(), validateCtx(deps, ctx));
  if (!v.ok) return denyValidation(ctx, v);
  const n = v.normalized as Extract<NormalizedAction, { op: "read" }>;
  try {
    const r = await deps.mb.call(n.contract.address, n.contract.label, n.method, { args: n.args, contractOverride: true });
    if (r.kind !== "MethodCallResponse") return refusal(502, "multibaas_error", `${n.method} did not return a value`);
    return { ok: true, body: { contract: n.contract, method: n.method, args: n.args, output: cleanValue(r.output) } };
  } catch (e) {
    return mbRefusal(e);
  }
}

export type ChainEvent = {
  txHash: Hex;
  block: number;
  blockHash: Hex;
  logIndex: number;
  name: string;
  /** Decoded inputs as MultiBaas returned them (untrusted data). */
  inputs: { name: string; value: unknown }[];
  contract: Address;
  explorerUrl: string;
};
export type EventsOutput = { contract: ResolvedContract; events: ChainEvent[]; range: { fromBlock: number | null; toBlock: number | null; count: number } };

/** The event signature MultiBaas filters on, e.g. "Transfer(address,address,uint256)". */
export function eventSignature(abi: readonly unknown[], name: string): string | null {
  const ev = abi.find((x) => (x as { type?: string; name?: string }).type === "event" && (x as { name?: string }).name === name) as { inputs: { type: string }[] } | undefined;
  return ev ? `${name}(${ev.inputs.map((i) => i.type).join(",")})` : null;
}

export function mapEvent(e: MbEvent, ws: ChainWorkspace): ChainEvent | null {
  const t = e?.transaction;
  if (!t || typeof t.txHash !== "string" || !Number.isSafeInteger(t.blockNumber)) return null;
  return {
    txHash: t.txHash.toLowerCase() as Hex,
    block: t.blockNumber,
    blockHash: (t.blockHash ?? "0x").toLowerCase() as Hex,
    logIndex: Number.isSafeInteger(e.event?.indexInLog) ? e.event.indexInLog : 0,
    name: String(cleanValue(e.event?.name ?? "")),
    inputs: (e.event?.inputs ?? []).slice(0, 12).map((i) => ({ name: String(cleanValue(i?.name ?? "")), value: cleanValue(i?.value) })),
    contract: e.event?.contract?.address && isAddress(e.event.contract.address, { strict: false }) ? getAddress(e.event.contract.address) : ("0x0000000000000000000000000000000000000000" as Address),
    explorerUrl: explorerTx(ws, t.txHash.toLowerCase()),
  };
}

/** events: recent indexed events of a granted contract, oldest first. */
export async function eventsOp(deps: ChainDeps, ctx: AgentContext, action: ChainAction): Promise<OpResult<EventsOutput>> {
  if (action?.op !== "events") return refusal(400, "bad_request", "expected an events action");
  const v = validateAction(action, ctx.eff.grant, ctx.ws, deps.store.escrows(), validateCtx(deps, ctx));
  if (!v.ok) return denyValidation(ctx, v);
  const n = v.normalized as Extract<NormalizedAction, { op: "events" }>;
  const arts = deps.artifacts ?? { token: CHAIN_ARTIFACTS["relay-token"], vault: CHAIN_ARTIFACTS["relay-vault"], escrow: CHAIN_ARTIFACTS["relay-escrow"] };
  const sig = n.event ? eventSignature(arts[n.contract.kind].abi, n.event) : null;
  try {
    const raw = await deps.mb.events({ contract_address: n.contract.address, ...(sig ? { event_signature: sig } : {}), limit: n.limit });
    const events = (Array.isArray(raw) ? raw : [])
      .map((e) => mapEvent(e, ctx.ws))
      .filter((e): e is ChainEvent => !!e)
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    return {
      ok: true,
      body: {
        contract: n.contract,
        events,
        range: { fromBlock: events.length ? events[0].block : null, toBlock: events.length ? events[events.length - 1].block : null, count: events.length },
      },
    };
  } catch (e) {
    return mbRefusal(e);
  }
}

export type TxOutput = {
  hash: Hex;
  found: boolean;
  pending: boolean;
  from: Address | null;
  to: Address | null;
  blockNumber: number | null;
  blockHash: Hex | null;
  status: "success" | "reverted" | null;
  confirmations: number;
  contractAddress: Address | null;
  explorerUrl: string;
  proposal: { id: string; state: ProposalState } | null;
};

/** tx: status of a hash from this agent's subtree's proposals, or a tx to a granted contract. */
export async function txOp(deps: ChainDeps, ctx: AgentContext, action: ChainAction): Promise<OpResult<TxOutput>> {
  if (action?.op !== "tx") return refusal(400, "bad_request", "expected a tx action");
  const v = validateAction(action, ctx.eff.grant, ctx.ws, deps.store.escrows(), validateCtx(deps, ctx));
  if (!v.ok) return denyValidation(ctx, v);
  const hash = (v.normalized as Extract<NormalizedAction, { op: "tx" }>).hash;
  const own = deps.store.proposals((p) => p.submit?.hash?.toLowerCase() === hash && inSubtree(p.agent.name, ctx.name))[0] ?? null;
  try {
    const t = await deps.mb.tx(hash);
    if (!t && !own) return refusal(404, "not_found", `no transaction ${hash}`);
    const to = t?.data?.to && isAddress(t.data.to, { strict: false }) ? getAddress(t.data.to) : null;
    if (!own) {
      const g = ctx.eff.grant!;
      const escrows = branchEscrows(deps, ctx);
      const kind = !to
        ? null
        : isAddressEqual(to, ctx.ws.token.address)
          ? "token"
          : isAddressEqual(to, ctx.ws.vault.address)
            ? "vault"
            : escrows.some((e) => isAddressEqual(e.address, to))
              ? "escrow"
              : null;
      if (!kind || !g.contracts.includes(kind)) return refusal(403, "blocked", "the transaction isn't one of this agent's proposals or a call to a contract in its grant", { rule: "contract" });
    }
    const rc = await deps.mb.receipt(hash);
    const r = rc ? summarizeReceipt(rc) : null;
    const head = r ? (await deps.mb.status()).blockNumber : 0;
    return {
      ok: true,
      body: {
        hash,
        found: !!t,
        pending: !r,
        from: t?.from && isAddress(t.from, { strict: false }) ? getAddress(t.from) : null,
        to,
        blockNumber: r?.blockNumber ?? null,
        blockHash: r?.blockHash ?? null,
        status: r?.status ?? null,
        confirmations: r ? Math.max(0, head - r.blockNumber + 1) : 0,
        contractAddress: r?.contractAddress ?? null,
        explorerUrl: explorerTx(ctx.ws, hash),
        proposal: own ? { id: own.id, state: own.state } : null,
      },
    };
  } catch (e) {
    return mbRefusal(e);
  }
}

// --- Proposals -----------------------------------------------------------------------------

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function describeTarget(ws: ChainWorkspace, n: Extract<NormalizedAction, { op: "call" | "deploy" }>) {
  const sym = ws.token.symbol;
  const who = (a: Address) => {
    const named = recipientName(ws, a);
    return named ? `${named} (${a})` : a;
  };
  if (n.op === "deploy") {
    const amt = formatAmount(n.amountBase, ws.token.decimals);
    const payer = isAddressEqual(n.callArgs[1], ws.vault.address) ? "the vault" : short(n.callArgs[1]);
    return { summary: `deploy an escrow: ${amt} ${sym} from ${payer} to ${who(n.recipient)}, admin ${n.admin}`, amount: amt, recipient: n.recipient };
  }
  if (n.amountBase !== null && n.recipient) {
    const amt = formatAmount(n.amountBase, ws.token.decimals);
    const from = n.contract.kind === "vault" ? " from the vault" : "";
    return { summary: `${n.method} ${amt} ${sym} to ${who(n.recipient)}${from}`, amount: amt, recipient: n.recipient };
  }
  return { summary: `${n.contract.kind}.${n.method}(${n.args.map((a) => String(a)).join(", ")}) on ${n.contract.address}` };
}

const ledgerLevels = (eff: EffectiveResult): LedgerLevel[] => eff.perLevel.map((l) => ({ name: l.name, node: l.node, resource: l.resource, limit: l.limit, bucket: l.bucket }));

/** Client args as bounded plain data (for a blocked proposal's record). */
const safeArgs = (args: unknown): string[] => (Array.isArray(args) ? args.slice(0, 8).map((a) => String(typeof a === "object" ? JSON.stringify(a) : a).slice(0, 120)) : []);

function blockedProposal(ctx: AgentContext, requestId: string, action: ChainAction, rule: string, reason: string): Proposal {
  const a = action as Partial<Extract<ChainAction, { op: "call" }>> & Partial<Extract<ChainAction, { op: "deploy" }>>;
  const isDeploy = action?.op === "deploy";
  const contract = typeof a.contract === "string" ? a.contract : "";
  const kind = isDeploy ? "deploy" : contract === "token" ? "token" : contract === "vault" ? "vault" : isAddress(contract, { strict: false }) && isAddressEqual(contract, ctx.ws.token.address) ? "token" : isAddress(contract, { strict: false }) && isAddressEqual(contract, ctx.ws.vault.address) ? "vault" : "escrow";
  const address = isDeploy ? null : kind === "token" ? getAddress(ctx.ws.token.address) : kind === "vault" ? getAddress(ctx.ws.vault.address) : isAddress(contract, { strict: false }) ? getAddress(contract) : null;
  const method = isDeploy ? "constructor" : typeof a.method === "string" ? a.method.slice(0, 64) : "";
  const args = isDeploy ? safeArgs(a.args && typeof a.args === "object" ? Object.entries(a.args).map(([k, v]) => `${k}=${String(v)}`) : []) : safeArgs(a.args);
  return createProposal({
    requestId,
    agent: { name: ctx.name, node: ctx.node, resource: ctx.leaf.resource ?? "", owner: getAddress(ctx.leaf.owner!) },
    op: isDeploy ? "deploy" : "call",
    network: "sepolia",
    target: { kind, address, label: isDeploy ? ctx.ws.templates.escrow.label : kind === "token" ? ctx.ws.token.label : kind === "vault" ? ctx.ws.vault.label : ctx.ws.templates.escrow.label },
    method,
    args,
    display: { summary: `blocked: ${isDeploy ? "deploy escrow" : `${kind}.${method}`}(${args.join(", ")})`.slice(0, 300) },
    tx: null,
    gasEstimate: "0",
    grantId: ctx.eff.grantId,
    approval: { required: true, rule: "blocked" },
    block: { rule, reason },
  });
}

/** In-flight prepares by agent|requestId, so a repeated request shares one MultiBaas prepare. */
const g = globalThis as unknown as { __relayChainPrepares?: Map<string, Promise<OpResult<{ proposal: Proposal; created: boolean }>>>; __relayChainSubmitLock?: Promise<unknown>; __relayChainNonce?: Map<string, number> };
const prepares = () => (g.__relayChainPrepares ??= new Map());

/**
 * prepare / deploy: validates the action, asks MultiBaas for the unsigned tx
 * (from the relay signer) and stores a proposal: `awaiting-approval` or
 * `approved` by the grant's approval rule, or `blocked` naming the rule. A
 * repeated requestId returns the existing proposal without a second prepare.
 */
export async function propose(deps: ChainDeps, ctx: AgentContext, requestId: unknown, action: ChainAction): Promise<OpResult<{ proposal: Proposal; created: boolean }>> {
  if (!validRequestId(requestId)) return refusal(400, "bad_request", "requestId must be 1–128 of A-Z a-z 0-9 _ . : -");
  if (!action || typeof action !== "object" || (action.op !== "call" && action.op !== "deploy")) return refusal(400, "bad_request", 'action.op must be "call" or "deploy"');
  const existing = deps.store.findRequest(ctx.name, requestId);
  if (existing) return { ok: true, status: 200, body: { proposal: existing, created: false } };
  const key = `${ctx.name}|${requestId}`;
  const running = prepares().get(key);
  if (running) {
    const r = await running;
    return r.ok ? { ok: true, status: 200, body: { proposal: r.body.proposal, created: false } } : r;
  }
  const job = proposeNow(deps, ctx, requestId, action);
  prepares().set(key, job);
  try {
    return await job;
  } finally {
    prepares().delete(key);
  }
}

async function proposeNow(deps: ChainDeps, ctx: AgentContext, requestId: string, action: ChainAction): Promise<OpResult<{ proposal: Proposal; created: boolean }>> {
  const { ws, eff } = ctx;
  const block = (rule: string, reason: string): OpResult<{ proposal: Proposal; created: boolean }> => {
    const stored = deps.store.addProposal(blockedProposal(ctx, requestId, action, rule, reason));
    const r = denyValidation(ctx, { rule, reason });
    return { ...r, proposal: stored.proposal };
  };

  if (!eff.grant) return block("grant", eff.reason ?? "no blockchain grant");
  const v = validateAction(action, eff.grant, ws, deps.store.escrows(), validateCtx(deps, ctx));
  if (!v.ok) return block(v.rule, v.reason);
  const n = v.normalized as Extract<NormalizedAction, { op: "call" | "deploy" }>;

  // Payments: the aggregate allowance must have room at every level (reserved for real at submit).
  const amountBase = n.op === "call" ? n.amountBase : null;
  if (amountBase !== null) {
    const usage = deps.store.ledger(ws.token.address).usage(ledgerLevels(eff));
    const short = usage.find((u) => u.remaining < amountBase);
    if (short)
      return block("limit", `${formatAmount(amountBase, ws.token.decimals)} ${ws.token.symbol} is over ${short.name}'s remaining allowance of ${formatAmount(short.remaining, ws.token.decimals)} ${ws.token.symbol} (${short.period})`);
  }

  // MultiBaas composes the unsigned tx from the relay signer.
  let tx: MbTx;
  let deployAt: Address | null = null;
  try {
    if (n.op === "deploy") {
      const d = await deps.mb.deploy(ws.templates.escrow.label, ws.templates.escrow.version, { args: n.args, from: ws.signer });
      tx = d.tx;
      deployAt = d.deployAt && isAddress(d.deployAt, { strict: false }) ? getAddress(d.deployAt) : null;
    } else {
      tx = await deps.mb.prepare(n.contract.address, n.contract.label, n.method, {
        args: n.args,
        from: ws.signer,
        contractOverride: true,
        ...(n.gas !== null ? { gas: Number(n.gas) } : {}),
      });
    }
  } catch (e) {
    return mbRefusal(e);
  }
  // The relay signs only the calldata it validated: MultiBaas must have composed exactly that.
  const mbData = (tx.data || "0x").toLowerCase();
  const mbTo = tx.to ? tx.to.toLowerCase() : null;
  const wantTo = n.op === "deploy" ? null : n.contract.address.toLowerCase();
  if (mbData !== n.data.toLowerCase() || mbTo !== wantTo) {
    return refusal(502, "prepare_mismatch", "MultiBaas prepared a different transaction than the one the relay validated; nothing was stored");
  }
  if (!Number.isSafeInteger(tx.gas) || tx.gas <= 0) return refusal(502, "multibaas_error", "MultiBaas returned no gas estimate");
  const gas = n.op === "call" && n.gas !== null ? n.gas : BigInt(tx.gas);
  const gasBad = checkGas(eff.grant, gas);
  if (gasBad) return block(gasBad.rule, gasBad.reason);

  const approval = approvalRequirement(eff.grant, amountBase);
  const display = describeTarget(ws, n);
  const p = createProposal(
    {
      requestId,
      agent: { name: ctx.name, node: ctx.node, resource: ctx.leaf.resource ?? "", owner: getAddress(ctx.leaf.owner!) },
      op: n.op,
      network: "sepolia",
      target:
        n.op === "deploy"
          ? { kind: "deploy", address: deployAt, label: ws.templates.escrow.label }
          : { kind: n.contract.kind, address: n.contract.address, label: n.contract.label },
      method: n.op === "deploy" ? "constructor" : n.method,
      args: n.args,
      display,
      tx: {
        from: getAddress(ws.signer),
        to: n.op === "deploy" ? null : n.contract.address,
        data: n.data.toLowerCase() as Hex,
        value: "0",
        gas: gas.toString(),
        nonce: tx.nonce,
        type: tx.type,
        ...(tx.gasFeeCap ? { maxFeePerGas: tx.gasFeeCap } : {}),
        ...(tx.gasTipCap ? { maxPriorityFeePerGas: tx.gasTipCap } : {}),
        ...(tx.gasPrice ? { gasPrice: tx.gasPrice } : {}),
      },
      gasEstimate: String(tx.gas),
      grantId: eff.grantId,
      approval,
      ...(amountBase !== null ? { amountBase: amountBase.toString() } : {}),
    },
    nowOf(deps),
  );
  const stored = deps.store.addProposal(p);
  return { ok: true, status: stored.created ? 201 : 200, body: stored };
}

// --- Submit --------------------------------------------------------------------------------

/** The typed action a stored proposal was made from (validated again at submit). */
export function actionOf(p: Proposal, ws: ChainWorkspace): ChainAction {
  if (p.op === "deploy") {
    const [token, payer, payee, amount, admin] = p.args as string[];
    return { op: "deploy", template: "escrow", args: { token: token as Address, payer: payer as Address, payee: payee as Address, amount: /^\d+$/.test(String(amount)) ? formatAmount(BigInt(amount), ws.token.decimals) : String(amount), admin: admin as Address } };
  }
  const contract = p.target.kind === "token" || p.target.kind === "vault" ? p.target.kind : (p.target.address as Address);
  return { op: "call", contract, method: p.method, args: p.args, gas: p.tx?.gas };
}

/** Serializes signing + broadcast in this process (one nonce sequence for the relay signer). */
async function withSubmitLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = g.__relayChainSubmitLock ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  g.__relayChainSubmitLock = prev.then(() => mine);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

const nonces = () => (g.__relayChainNonce ??= new Map());

/**
 * submit: the proposing agent or an ancestor agent sends an approved proposal.
 * Rechecks everything with fresh chain data, reserves the allowance at every
 * level, signs with the relay signer, records the hash, then broadcasts.
 */
export async function submit(deps: ChainDeps, caller: AgentContext, id: string): Promise<OpResult<Proposal>> {
  let p = deps.store.proposal(id);
  if (!p) return refusal(404, "not_found", `no proposal ${String(id).slice(0, 60)}`);
  if (!inSubtree(p.agent.name, caller.name)) return refusal(403, "denied", `${caller.name} can't submit ${p.agent.name}'s proposals`);
  const at = nowOf(deps);
  if (isDue(p, at)) {
    p = deps.store.updateProposal(id, (cur) => expireIfDue(cur, at));
    logProposal(deps, p, "not submitted within 30 minutes");
  }
  const gate = submitGate(p, at);
  if (gate.action === "return") return { ok: true, status: 200, body: gate.proposal };
  if (gate.action === "refuse") return refusal(gate.status, gate.error, gate.reason, { proposal: p });

  const capMiss = requireCap(caller.eff.grant, "submit");
  if (capMiss) return refusal(403, "blocked", caller.eff.grant ? capMiss.reason : (caller.eff.reason ?? capMiss.reason), { rule: capMiss.rule });

  // Fresh ENS policy and grant for the proposing agent.
  const fresh = p.agent.name === caller.name ? caller : await agentContext(deps, p.agent.name, null, null);
  if (isRefusal(fresh)) return fresh;
  if (!fresh.leaf.owner || !isAddressEqual(fresh.leaf.owner, p.agent.owner) || (fresh.leaf.resource ?? "") !== p.agent.resource) {
    return refusal(403, "access revoked", `${p.agent.name} changed hands or was re-registered since the proposal was made`);
  }
  const ws = fresh.ws;
  const blockNow = (rule: string, reason: string): Refusal => {
    const moved = deps.store.updateProposal(id, (cur) => (cur.state === "approved" ? transition(cur, "blocked", `blocked at submit by ${rule}: ${reason}`, nowOf(deps), { block: { rule, reason } }) : cur));
    logProposal(deps, moved, `blocked at submit by ${rule}: ${reason}`, false);
    return { ...denyValidation(fresh, { rule, reason }), proposal: moved };
  };
  if (!fresh.eff.grant) return blockNow("grant", fresh.eff.reason ?? "no blockchain grant");
  const v = validateAction(actionOf(p, ws), fresh.eff.grant, ws, deps.store.escrows(), validateCtx(deps, fresh));
  if (!v.ok) return blockNow(v.rule, v.reason);
  const n = v.normalized as Extract<NormalizedAction, { op: "call" | "deploy" }>;
  if (!p.tx || n.data.toLowerCase() !== p.tx.data.toLowerCase()) return blockNow("args", "the proposal's calldata no longer matches its action");
  const gasBad = checkGas(fresh.eff.grant, BigInt(p.tx.gas));
  if (gasBad) return blockNow(gasBad.rule, gasBad.reason);
  const amountBase = p.amountBase ? BigInt(p.amountBase) : null;
  const need = approvalRequirement(fresh.eff.grant, amountBase);
  if (need.required && !(p.approval.approver && p.approval.digest?.toLowerCase() === p.digest.toLowerCase())) {
    return refusal(403, "approval_required", `the grant now requires a human approval (${need.rule}); approve it in the portal first`, { proposal: p });
  }

  const key = deps.signerKey();
  if (!key) return refusal(503, "signer_not_configured", "the relay signer's key (MULTIBAAS_SIGNER_PRIVATE_KEY) isn't set");
  const account = privateKeyToAccount(key);
  if (!isAddressEqual(account.address, ws.signer)) return refusal(503, "signer_mismatch", `MULTIBAAS_SIGNER_PRIVATE_KEY is for ${account.address}, not the workspace signer ${ws.signer}`);

  return withSubmitLock(async (): Promise<OpResult<Proposal>> => {
    // Another submit may have gone first while this one waited.
    const cur = deps.store.proposal(id)!;
    const again = submitGate(cur, nowOf(deps));
    if (again.action === "return") return { ok: true, status: 200, body: again.proposal };
    if (again.action === "refuse") return refusal(again.status, again.error, again.reason, { proposal: cur });
    // The wait for the lock can be long (another submit's prepare + broadcast): a pause or a changed
    // approved scope that landed meanwhile must stop this one before anything is reserved or signed.
    const guardNow = guardProblem(deps, fresh);
    if (guardNow) {
      logProposal(deps, cur, `not submitted: ${guardNow}`, false);
      return refusal(403, "paused", guardNow, { proposal: cur, proven: true });
    }

    // Reserve the allowance at every level of the proposing agent, all or nothing.
    const ledger = deps.store.ledger(ws.token.address);
    // One id per attempt: an attempt that fails before broadcast releases its hold, and the ledger never
    // re-reserves a released id. Double submits are stopped earlier (the submit lock and the proposal's
    // state), and the id that ends up holding the allowance is stored on the proposal for the tracker.
    const reservationId = amountBase !== null ? `rsv_${cur.id}_${randomBytes(4).toString("hex")}` : undefined;
    if (amountBase !== null && reservationId) {
      const r = ledger.reserve(ledgerLevels(fresh.eff), amountBase, reservationId, new Date(nowOf(deps) * 1000));
      if (!r.ok) {
        const reason = r.level
          ? `${formatAmount(amountBase, ws.token.decimals)} ${ws.token.symbol} is over ${r.level}'s remaining allowance of ${formatAmount(r.remaining, ws.token.decimals)} ${ws.token.symbol}`
          : r.reason;
        return refusal(403, "blocked", reason, { rule: "limit", proposal: cur });
      }
    }
    const releaseHold = () => {
      if (reservationId) ledger.release(reservationId);
    };

    // A fresh nonce and fees (the proposal may be minutes old), then sign exactly the approved to/data/gas.
    let prepared: MbTx;
    try {
      prepared =
        cur.op === "deploy"
          ? (await deps.mb.deploy(ws.templates.escrow.label, ws.templates.escrow.version, { args: cur.args, from: ws.signer, gas: Number(cur.tx!.gas) })).tx
          : await deps.mb.prepare(cur.target.address!, cur.target.label, cur.method, { args: cur.args, from: ws.signer, contractOverride: true, gas: Number(cur.tx!.gas) });
    } catch (e) {
      releaseHold();
      return mbRefusal(e);
    }
    const signerKeyLc = ws.signer.toLowerCase();
    const nonce = Math.max(prepared.nonce, nonces().get(signerKeyLc) ?? 0);
    const unsigned: MbTx = {
      from: ws.signer,
      to: cur.tx!.to,
      nonce,
      gas: Number(cur.tx!.gas),
      value: "0",
      data: cur.tx!.data,
      type: prepared.type,
      ...(prepared.gasFeeCap ? { gasFeeCap: prepared.gasFeeCap } : {}),
      ...(prepared.gasTipCap ? { gasTipCap: prepared.gasTipCap } : {}),
      ...(prepared.gasPrice ? { gasPrice: prepared.gasPrice } : {}),
    };
    let signed: { serialized: Hex; hash: Hex };
    try {
      signed = await signMbTx(account, unsigned, ws.network.chainId);
    } catch (e) {
      releaseHold();
      return refusal(502, "sign_failed", mbReason(e));
    }
    const hash = signed.hash.toLowerCase() as Hex;

    // The hash is stored before the broadcast: a crash leaves `submitting` with a hash to look up, never a resend.
    const t0 = nowOf(deps);
    let p1: Proposal;
    try {
      p1 = deps.store.updateProposal(id, (x) =>
        transition(x, "submitting", `signed by the relay signer ${ws.signer} (nonce ${nonce}); hash ${hash}`, t0, {
          submit: { hash, at: t0 },
          ...(reservationId ? { reservationId } : {}),
          tx: {
            ...x.tx!,
            nonce,
            type: prepared.type,
            ...(prepared.gasFeeCap ? { maxFeePerGas: prepared.gasFeeCap } : {}),
            ...(prepared.gasTipCap ? { maxPriorityFeePerGas: prepared.gasTipCap } : {}),
            ...(prepared.gasPrice ? { gasPrice: prepared.gasPrice } : {}),
          },
        }),
      );
    } catch (e) {
      releaseHold();
      if (e instanceof ChainStoreError) return refusal(e.status, e.code, e.message);
      return refusal(409, "not_submittable", e instanceof Error ? e.message : String(e));
    }
    logProposal(deps, p1, `signed; hash ${hash}`);

    // Only `submitting` moves on from here: the tracker may already have resolved it by hash.
    const fromSubmitting = (to: "submitted" | "uncertain" | "failed", detail: string, patch: Partial<Proposal> = {}) =>
      deps.store.updateProposal(id, (x) => (x.state === "submitting" ? transition(x, to, detail, nowOf(deps), patch) : x));
    let out: Proposal;
    let broadcast: { hash?: Hex } | null = null;
    let sendError: unknown = null;
    try {
      broadcast = await deps.mb.submit(signed.serialized);
    } catch (e) {
      sendError = e;
    }
    if (broadcast) {
      nonces().set(signerKeyLc, nonce + 1);
      const note = broadcast.hash && broadcast.hash !== hash ? ` (MultiBaas reported ${broadcast.hash}; tracking the signed hash)` : "";
      out = fromSubmitting("submitted", `broadcast via MultiBaas${note}`);
      logProposal(deps, out, `submitted ${hash}`);
    } else if (!definiteRefusal(sendError)) {
      // No answer, a 5xx, an unreadable 2xx, a 2xx without a hash…: MultiBaas may have accepted the
      // raw tx. The reservation stays held and the nonce moves on; only the tracker resolves it by hash.
      nonces().set(signerKeyLc, nonce + 1);
      out = fromSubmitting("uncertain", `broadcast outcome unknown (${mbReason(sendError)}); tracking ${hash}, not re-sending`, { error: mbReason(sendError) });
      logProposal(deps, out, `uncertain: ${mbReason(sendError)}`, false);
    } else {
      out = fromSubmitting("failed", `MultiBaas refused the transaction: ${mbReason(sendError)}`, { error: mbReason(sendError) });
      if (out.state === "failed") releaseHold();
      logProposal(deps, out, `failed: ${mbReason(sendError)}`, false);
    }
    if (deps.track === undefined) ensureTracking(deps);
    else deps.track?.();
    return { ok: true, status: 200, body: out };
  });
}

/**
 * Whether a broadcast error means the transaction was certainly NOT accepted:
 * nothing was sent (config problem), or MultiBaas answered 4xx with a parsed
 * error envelope. Anything else (timeouts, 5xx, a 2xx that didn't parse or had
 * no hash) is an unknown outcome.
 */
export function definiteRefusal(e: unknown): boolean {
  if (!(e instanceof MultiBaasError)) return false;
  if (e.kind === "invalid") return true;
  return e.kind === "http" && e.refused && e.status >= 400 && e.status < 500;
}

/** The guard's verdict for the proposing agent right now (null = fine), as decide() would give it. */
function guardProblem(deps: ChainDeps, fresh: AgentContext): string | null {
  const guard = deps.relay.guard ?? null;
  if (!guard) return null;
  const levels = fresh.decision.levels;
  const nowSec = nowOf(deps);
  try {
    const broken = guard.unavailable?.() ?? null;
    if (broken) {
      const member = memberLevelIndex(levels, deps.relay.config.rootOwner);
      return member >= 0 && levels.length - 1 > member ? `approvals store unavailable: ${broken}` : null;
    }
    const pause = guard.paused(levels, nowSec);
    if (pause) return `paused: ${pause.name} is under review (incident ${pause.incidentId}). An approver must review it in the portal.`;
    const overlays = guard.overlays(levels, nowSec).filter((o) => levels.some((l) => l.name === o.after));
    const ids = (list: { id: string }[]) => list.map((o) => o.id).sort().join(",");
    if (ids(overlays) !== ids(fresh.decision.overlays) || overlays.some((o) => !(o.notAfter > nowSec))) {
      return "the approved scope changed while this submit waited; submit again";
    }
  } catch (e) {
    return `approvals store unavailable: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

// --- Allowance view ----------------------------------------------------------------------

export type AllowanceRow = { name: string; limit: string | null; spent: string; reserved: string; period?: string };

/** Allowance used per level for an agent's grant (STD decimal strings). */
export function allowanceRows(deps: ChainDeps, ctx: AgentContext): AllowanceRow[] {
  const dec = ctx.ws.token.decimals;
  return deps.store
    .ledger(ctx.ws.token.address)
    .usage(ledgerLevels(ctx.eff), new Date(nowOf(deps) * 1000))
    .map((u) => ({ name: u.name, limit: formatAmount(u.limit, dec), spent: formatAmount(u.spent, dec), reserved: formatAmount(u.reserved, dec), period: u.period }));
}

// --- Approval hooks ----------------------------------------------------------------------

/** Marks a proposal approved (bound to the digest the approver signed). Throws when it can't be. */
export function chainApprovalApplied(store: ChainStore, id: string, a: HookApproval, meter?: Meter | null): Proposal {
  const p = store.updateProposal(id, (cur) => {
    if (cur.state !== "awaiting-approval") throw new Error(`proposal ${id} is ${cur.state}`);
    return approve(cur, { approver: getAddress(a.approver), digest: a.digest, at: a.at, challengeId: a.challengeId });
  });
  if (meter) logProposal({ relay: { meter } }, p, `approved by ${a.approver} (challenge ${a.challengeId}); the agent submits next`);
  return p;
}

/** Marks a proposal rejected by an approver. */
export function chainRejectionApplied(store: ChainStore, id: string, a: HookApproval, meter?: Meter | null): Proposal {
  const p = store.updateProposal(id, (cur) => {
    if (cur.state !== "awaiting-approval") throw new Error(`proposal ${id} is ${cur.state}`);
    if (a.digest.toLowerCase() !== cur.digest.toLowerCase()) throw new Error("rejection is for a different proposal digest");
    return transition(cur, "rejected", `rejected by ${a.approver}`, a.at, { approval: { ...cur.approval, approver: getAddress(a.approver), at: a.at, challengeId: a.challengeId, digest: a.digest } });
  });
  if (meter) logProposal({ relay: { meter } }, p, `rejected by ${a.approver}`, false);
  return p;
}

/** What the approvals module shows and binds for a proposal. */
export function proposalView(p: Proposal, at: number): ProposalView {
  return { id: p.id, state: isDue(p, at) ? "expired" : p.state, digest: p.digest, agent: p.agent, summary: p.display.summary, expiresAt: p.expiresAt };
}

/**
 * Sets the approvals hooks (lib/relay/approvals/hooks.ts) to this process's
 * chain store. Called at module load with the defaults; tests pass their own.
 */
export function registerApprovalHooks(getStore: () => ChainStore = () => chainStore(), getMeterFn: () => Meter | null = defaultMeter) {
  hooks.proposal = (id) => {
    const s = getStore();
    if (s.unavailable()) return null;
    const p = s.proposal(id);
    return p ? proposalView(p, Math.floor(Date.now() / 1000)) : null;
  };
  hooks.proposalApproved = (id, a) => void chainApprovalApplied(getStore(), id, a, getMeterFn());
  hooks.proposalRejected = (id, a) => void chainRejectionApplied(getStore(), id, a, getMeterFn());
}

function defaultMeter(): Meter | null {
  try {
    return getMeter(getConfig().dataDir);
  } catch {
    return null;
  }
}

registerApprovalHooks();
