// HTTP handlers for /api/relay/chain/* (the route files are thin wrappers).
//
// Agent routes authenticate exactly like the provider route: a kr1 token
// (x-api-key or Bearer) signed by the key that owns the token's name, for this
// relay's audience, not revoked by relay.nbf; unknown (name, signer) pairs
// share the per-client failure budget. Then ENS policy for provider
// "multibaas" and the effective blockchain grant (executor.agentContext).
// Every tool request is written to the activity log, refusals too (once the
// caller has shown it owns a live name).
//
// Public (no token): GET /status and the proposal list/detail, which hold
// names, targets, amounts and states but no secrets (like the access tree).

import { type Address, type Hex, formatEther, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { tryNormalize } from "../ens/names";
import { multibaasFromConfig } from "../multibaas/client";
import { applyDnsAlias } from "../relay/config";
import { relayDeps } from "../relay/policy";
import { clientKey, isKnownGood, markKnownGood, relayLimits } from "../relay/ratelimit";
import { TokenError, tokenFromHeaders, verifyToken } from "../relay/token";
import { loadChainWorkspace, signerKey } from "./config";
import {
  type AgentContext,
  type ChainDeps,
  type OpResult,
  type Refusal,
  agentContext,
  allowanceRows,
  eventsOp,
  inSubtree,
  isRefusal,
  logOp,
  nowOf,
  propose,
  readOp,
  refusal,
  refusalText,
  registerApprovalHooks,
  submit,
  txOp,
} from "./executor";
import { runTask, MAX_TASK_CHARS } from "./planner";
import { type Proposal, expireIfDue, isDue } from "./proposals";
import { chainStore } from "./store";
import { ensureTracking, trackerState } from "./tracker";
import type { ChainAction, ContractRef } from "./validate";
import { formatAmount } from "./grant";

const NO_STORE = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });
const fail = (r: Pick<Refusal, "status" | "error" | "reason" | "rule" | "proposal">) =>
  json({ error: r.error, reason: r.reason, ...(r.rule ? { rule: r.rule } : {}), ...(r.proposal ? { proposal: withState(r.proposal) } : {}) }, r.status);

/** A proposal as the routes return it (a blocked one also carries rule/reason at the top level for the UI). */
const withState = (p: Proposal) => (p.block ? { ...p, rule: p.block.rule, reason: p.block.reason } : p);

let resumed = false;

/** The server's chain runtime: config, MultiBaas, the chain store and the signer key, all read per call. */
export function chainDeps(): ChainDeps {
  const deps: ChainDeps = {
    relay: relayDeps(),
    mb: multibaasFromConfig(),
    store: chainStore(),
    workspace: () => loadChainWorkspace(),
    signerKey: () => signerKey(),
  };
  if (!resumed) {
    resumed = true;
    try {
      ensureTracking(deps); // proposals left pending by a restart
    } catch {}
  }
  return deps;
}

/** Registers the approvals hooks and resumes tracking (call at server start; also runs lazily). */
export function startChainRuntime() {
  registerApprovalHooks();
  chainDeps();
}

async function readBody(request: Request, max = 64 * 1024): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? 0) > max) return null;
  const text = await request.text().catch(() => "");
  if (text.length > max) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

type Authed = { ctx: AgentContext; log: (allowed: boolean, reason: string | null, status: number) => void };

/**
 * Authenticates an agent request and builds its context. Returns a Response to
 * send when refused. Refusals after the caller proved ownership of a live name
 * are logged (op = the route's tool name).
 */
export async function authenticate(request: Request, deps: ChainDeps, op: string): Promise<Authed | Response> {
  const { config, meter } = deps.relay;
  const limits = deps.relay.limits ?? relayLimits();
  const client = clientKey(request.headers);
  const method = request.method.toUpperCase();
  const token = tokenFromHeaders(request.headers);
  if (!token) {
    meter.countRejected();
    return json({ error: "missing token", reason: "Send a Keyless Relay token (kr1...) as x-api-key or Authorization: Bearer." }, 401);
  }
  let signer: Address;
  let name: string;
  let iat: number;
  try {
    const v = await verifyToken(token, deps.relay.nowSec?.(), { maxTtlSec: config.maxTokenTtlSec, audiences: config.audiences });
    const normalized = tryNormalize(v.payload.name);
    if (!normalized) throw new TokenError("token names an invalid ENS name");
    signer = v.signer;
    iat = v.payload.iat;
    name = applyDnsAlias(normalized, config.dnsAlias);
  } catch (err) {
    meter.countRejected();
    const reason = err instanceof TokenError ? err.message : "bad token";
    return json({ error: reason.includes("expired") ? "token expired" : "bad token", reason }, 401);
  }
  const pair = `${name}|${signer}`;
  const known = isKnownGood(limits, pair);
  if (!known && !limits.failures.has(client)) {
    meter.countRejected();
    return Response.json({ error: "too many failed requests", reason: "Wait a minute and try again." }, { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });
  }
  const logFor = (allowed: boolean, reason: string | null, status: number) => logOp(meter, { name, signer, op, allowed, reason, status, method });

  const ctx = await agentContext(deps, name, signer, token);
  if (isRefusal(ctx)) {
    // Proven owners (paused, not allowed multibaas, no workspace) are logged; unknown pairs only counted.
    const proven = ctx.proven === true || known;
    if (proven && ctx.status !== 502) logFor(false, `${ctx.error}: ${ctx.reason}`, ctx.status);
    else if (ctx.status !== 502) {
      meter.countRejected();
      limits.failures.spend(client);
    }
    return fail(ctx);
  }
  markKnownGood(limits, pair);
  if (ctx.leaf.nbf && iat < ctx.leaf.nbf) {
    const reason = `tokens for ${ctx.leaf.name} issued before ${new Date(ctx.leaf.nbf * 1000).toISOString()} are refused (relay.nbf); sign a new one`;
    logFor(false, reason, 401);
    return json({ error: "token revoked", reason }, 401);
  }
  return { ctx, log: logFor };
}

/** Sends an op result, logging it (refusals name the rule and short grant id). */
function respond<T>(a: Authed, r: OpResult<T>, okText: (b: T) => string, shape: (b: T) => unknown = (b) => b): Response {
  if (r.ok) {
    a.log(true, `${okText(r.body)} (grant ${a.ctx.eff.grantId.slice(0, 10)})`, r.status ?? 200);
    return json(shape(r.body), r.status ?? 200);
  }
  a.log(false, refusalText(r, a.ctx.eff.grantId), r.status);
  return fail(r);
}

// --- Tool routes --------------------------------------------------------------------------------

/** POST /chain/read {contract, method, args} → {output}. */
export async function handleRead(request: Request, deps: ChainDeps = chainDeps()): Promise<Response> {
  const a = await authenticate(request, deps, "read");
  if (a instanceof Response) return a;
  const b = await readBody(request);
  if (!b) return respond(a, refusal(400, "bad_request", "send a JSON object {contract, method, args}"), () => "");
  const r = await readOp(deps, a.ctx, { op: "read", contract: b.contract as ContractRef, method: b.method as string, args: (b.args ?? []) as unknown[], ...(typeof b.network === "string" ? { network: b.network } : {}) });
  return respond(a, r, (x) => `read ${x.contract.kind}.${x.method}`);
}

/** POST /chain/events {contract, event?, limit?} → {events, range}. */
export async function handleEvents(request: Request, deps: ChainDeps = chainDeps()): Promise<Response> {
  const a = await authenticate(request, deps, "events");
  if (a instanceof Response) return a;
  const b = await readBody(request);
  if (!b) return respond(a, refusal(400, "bad_request", "send a JSON object {contract, event?, limit?}"), () => "");
  const r = await eventsOp(deps, a.ctx, {
    op: "events",
    contract: b.contract as Address,
    ...(b.event !== undefined && b.event !== null ? { event: b.event as string } : {}),
    ...(b.limit !== undefined ? { limit: b.limit as number } : {}),
    ...(typeof b.network === "string" ? { network: b.network } : {}),
  });
  return respond(a, r, (x) => `events ${x.contract.kind}: ${x.events.length}`, (x) => ({ contract: x.contract, events: x.events, range: x.range }));
}

/** GET /chain/tx/[hash] → status and receipt. */
export async function handleTx(request: Request, hash: string, deps: ChainDeps = chainDeps()): Promise<Response> {
  const a = await authenticate(request, deps, "tx");
  if (a instanceof Response) return a;
  const r = await txOp(deps, a.ctx, { op: "tx", hash: hash as Hex });
  return respond(a, r, (x) => `tx ${x.hash.slice(0, 10)}… ${x.pending ? "pending" : (x.status ?? "unknown")}`);
}

/** POST /chain/proposals {requestId, action} → the proposal (201 new, 200 existing; 403/422 blocked with the stored proposal). */
export async function handleCreateProposal(request: Request, deps: ChainDeps = chainDeps()): Promise<Response> {
  const a = await authenticate(request, deps, "proposals");
  if (a instanceof Response) return a;
  const b = await readBody(request);
  if (!b) return respond(a, refusal(400, "bad_request", "send a JSON object {requestId, action}"), () => "");
  const r = await propose(deps, a.ctx, b.requestId, b.action as ChainAction);
  return respond(
    a,
    r,
    (x) => `${x.created ? "" : "(repeat) "}${x.proposal.id} ${x.proposal.state}: ${x.proposal.display.summary}`,
    (x) => withState(x.proposal),
  );
}

/** Expires due proposals as they are read (no timer needed for expiry). */
function expireDue(deps: ChainDeps, list: Proposal[]): Proposal[] {
  const at = nowOf(deps);
  return list.map((p) => {
    if (!isDue(p, at)) return p;
    try {
      return deps.store.updateProposal(p.id, (cur) => expireIfDue(cur, at));
    } catch {
      return p;
    }
  });
}

/**
 * GET /chain/proposals: public list (`?all=1` or no token). With an agent
 * token and `scope=mine|subtree`, only that agent's (or its subtree's).
 */
export async function handleListProposals(request: Request, deps: ChainDeps = chainDeps()): Promise<Response> {
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope");
  const down = deps.store.unavailable();
  if (down) return json({ error: "chain_store_unavailable", reason: down }, 503);
  if (scope && url.searchParams.get("all") !== "1") {
    if (scope !== "mine" && scope !== "subtree") return json({ error: "bad_request", reason: "scope is mine or subtree" }, 400);
    const a = await authenticate(request, deps, "proposals");
    if (a instanceof Response) return a;
    const name = a.ctx.name;
    const list = deps.store.proposals((p) => (scope === "mine" ? p.agent.name === name : inSubtree(p.agent.name, name)));
    return json({ proposals: expireDue(deps, list).map(withState) });
  }
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  return json({ proposals: expireDue(deps, deps.store.proposals().slice(0, limit)).map(withState) });
}

/** GET /chain/proposals/[id] (public). `?allowance=1` adds per-level allowance use (one ENS read). */
export async function handleGetProposal(request: Request, id: string, deps: ChainDeps = chainDeps()): Promise<Response> {
  const down = deps.store.unavailable();
  if (down) return json({ error: "chain_store_unavailable", reason: down }, 503);
  const p0 = deps.store.proposal(id);
  if (!p0) return json({ error: "not_found", reason: `no proposal ${String(id).slice(0, 60)}` }, 404);
  const [p] = expireDue(deps, [p0]);
  const url = new URL(request.url);
  if (url.searchParams.get("allowance") === "1") {
    const ctx = await agentContext(deps, p.agent.name, null, null);
    if (!isRefusal(ctx)) return json({ ...withState(p), allowance: allowanceRows(deps, ctx) });
  }
  return json(withState(p));
}

/** POST /chain/proposals/[id]/submit (the proposing agent or an ancestor agent) → the proposal. */
export async function handleSubmit(request: Request, id: string, deps: ChainDeps = chainDeps()): Promise<Response> {
  const a = await authenticate(request, deps, "submit");
  if (a instanceof Response) return a;
  const r = await submit(deps, a.ctx, id);
  if (!r.ok) return respond(a, r, () => "");
  let allowance: ReturnType<typeof allowanceRows> | undefined;
  try {
    if (r.body.reservationId) allowance = r.body.agent.name === a.ctx.name ? allowanceRows(deps, a.ctx) : undefined;
  } catch {}
  return respond(a, r, (p) => `${p.id} ${p.state}${p.submit ? ` ${p.submit.hash}` : ""}`, (p) => ({ ...withState(p), ...(allowance ? { allowance } : {}) }));
}

/** POST /chain/task {task, as?} → {runId, plan, results, proposals, findings, report}. `as` may name this agent or one under it. */
export async function handleTask(request: Request, deps: ChainDeps = chainDeps()): Promise<Response> {
  const a = await authenticate(request, deps, "task");
  if (a instanceof Response) return a;
  const b = await readBody(request);
  const task = typeof b?.task === "string" ? b.task.trim() : "";
  if (!task || task.length > MAX_TASK_CHARS) return respond(a, refusal(400, "bad_request", `task must be 1–${MAX_TASK_CHARS} characters`), () => "");
  let ctx = a.ctx;
  if (typeof b?.as === "string" && b.as.trim()) {
    const raw = b.as.trim().toLowerCase();
    const target = raw.includes(".") ? raw : `${raw}.${ctx.name}`;
    const norm = tryNormalize(target);
    if (!norm || !inSubtree(norm, ctx.name)) return respond(a, refusal(403, "denied", `${raw} is not ${ctx.name} or a name under it`), () => "");
    if (norm !== ctx.name) {
      // Acting as a descendant: its own (narrower) grant; the caller's token pays for the model.
      const sub = await agentContext(deps, norm, null, ctx.token);
      if (isRefusal(sub)) return respond(a, sub, () => "");
      ctx = sub;
    }
  }
  const result = await runTask(deps, ctx, task);
  return json({ ...result, proposals: result.proposals.map(withState), results: result.results.map((r) => (r.proposal ? { ...r, proposal: withState(r.proposal) } : r)) });
}

// --- Status -------------------------------------------------------------------------------------

export type ChainStatusBody = {
  configured: boolean;
  network: string | null;
  chainId: number | null;
  block: number | null;
  signer: Address | null;
  /** ETH, decimal string. */
  signerBalance: string | null;
  vault: { address: Address; balance: string | null } | null;
  token: { address: Address; symbol: string; name: string; decimals: number } | null;
  templates: { escrow: { label: string; version: string; bytecodeHash: Hex; networks: string[] } } | null;
  recipients: Record<string, Address>;
  escrows: number;
  tracking: { running: boolean; pending: number };
  problems: string[];
};

const STATUS_TTL_MS = 30_000;
const LOW_GAS_WEI = 5_000_000_000_000_000n; // 0.005 ETH
const gs = globalThis as unknown as { __relayChainStatus?: { at: number; key: string; body: ChainStatusBody } };

/** GET /chain/status (public, no secrets). Cached 30 s to stay inside MultiBaas's monthly call budget. */
export async function chainStatus(deps: ChainDeps = chainDeps(), fresh = false): Promise<ChainStatusBody> {
  const ws = deps.workspace();
  const cfg = deps.relay.config;
  const key = `${ws?.vault.address ?? ""}|${cfg.upstreams.multibaas ?? ""}`;
  const cached = gs.__relayChainStatus;
  if (!fresh && cached && cached.key === key && Date.now() - cached.at < STATUS_TTL_MS) return cached.body;

  const problems: string[] = [];
  if (!ws) problems.push("no blockchain workspace (org/chain.json): run npm run chain:setup");
  if (!cfg.upstreams.multibaas) problems.push("MULTIBAAS_URL is not set");
  if (!cfg.keyFor("multibaas")) problems.push("MULTIBAAS_API_KEY is not set");
  const sk = deps.signerKey();
  if (!sk) problems.push("MULTIBAAS_SIGNER_PRIVATE_KEY is not set: proposals can be prepared and approved but not submitted");
  else if (ws && !isAddressEqual(privateKeyToAccount(sk).address, ws.signer)) problems.push(`MULTIBAAS_SIGNER_PRIVATE_KEY is not the workspace signer ${ws.signer}`);
  const storeDown = deps.store.unavailable();
  if (storeDown) problems.push(storeDown);

  const body: ChainStatusBody = {
    configured: false,
    network: ws?.network.name ?? null,
    chainId: ws?.network.chainId ?? null,
    block: null,
    signer: ws?.signer ?? null,
    signerBalance: null,
    vault: ws ? { address: ws.vault.address, balance: null } : null,
    token: ws ? { address: ws.token.address, symbol: ws.token.symbol, name: ws.token.name, decimals: ws.token.decimals } : null,
    templates: ws ? { escrow: { label: ws.templates.escrow.label, version: ws.templates.escrow.version, bytecodeHash: ws.templates.escrow.bytecodeHash, networks: [...ws.templates.escrow.networks] } } : null,
    recipients: ws ? { ...ws.recipients } : {},
    escrows: storeDown ? 0 : deps.store.escrows().length,
    tracking: { running: trackerState().running, pending: storeDown ? 0 : deps.store.proposals((p) => ["submitted", "included", "uncertain"].includes(p.state)).length },
    problems,
  };

  if (ws && cfg.upstreams.multibaas && cfg.keyFor("multibaas")) {
    try {
      const st = await deps.mb.status();
      body.block = st.blockNumber;
      if (st.chainID !== ws.network.chainId) problems.push(`MultiBaas is on chain ${st.chainID}, not ${ws.network.chainId}`);
      const [eth, vaultBal] = await Promise.all([deps.mb.balance(ws.signer).catch(() => null), deps.mb.tokenBalance(ws.token.address, ws.vault.address).catch(() => null)]);
      if (eth !== null) {
        body.signerBalance = formatEther(eth);
        if (eth < LOW_GAS_WEI) problems.push(`the relay signer has ${formatEther(eth)} ETH: fund it for gas`);
      }
      if (vaultBal !== null && body.vault) body.vault.balance = formatAmount(vaultBal, ws.token.decimals);
    } catch (e) {
      problems.push(`MultiBaas unreachable: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  }
  body.configured = !!ws && body.block !== null && !storeDown;
  gs.__relayChainStatus = { at: Date.now(), key, body };
  return body;
}

export async function handleStatus(_request: Request, deps: ChainDeps = chainDeps()): Promise<Response> {
  return json(await chainStatus(deps));
}

/** Drops the cached status (tests). */
export const resetChainStatus = () => {
  gs.__relayChainStatus = undefined;
};

// Hooks are set when this module loads (any chain route), and by startChainRuntime() at server start.
try {
  registerApprovalHooks();
} catch {}
