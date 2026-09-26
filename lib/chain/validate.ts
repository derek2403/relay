// Deterministic checks on a typed chain action against the caller's effective
// grant: capability, network, contract, method, ABI arguments, then the
// arguments' MEANING (recipient, amount, value, gas, constructor constraints).
// An ABI-valid call is not an authorized one: vault.pay to an unapproved
// address encodes fine and is refused here, before anything is prepared or
// signed. The approval rule is applied later (approvalRequirement in grant.ts).

import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  isAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
  zeroAddress,
} from "viem";

import { CHAIN_ARTIFACTS, type ChainArtifact } from "./artifacts";
import type { ChainWorkspace } from "./config";
import { type ChainCap, type ContractKind, type EffectiveGrant, WRITE_METHODS, formatAmount, parseAmount } from "./grant";
import type { DeployedEscrow } from "./store";

export type ContractRef = "token" | "vault" | Address;

/** A typed tool request. `network`, when given, must be a granted network (default: the workspace's). */
export type ChainAction =
  | { op: "read"; contract: ContractRef; method: string; args: unknown[]; network?: string }
  | { op: "events"; contract: ContractRef; event?: string; limit?: number; network?: string }
  | { op: "tx"; hash: Hex; network?: string }
  | { op: "call"; contract: ContractRef; method: string; args: unknown[]; value?: string; gas?: string; network?: string }
  | { op: "deploy"; template: "escrow"; args: { payer: Address; payee: Address; amount: string; admin: Address; token?: Address }; network?: string };

export type RuleId =
  | "grant"
  | `cap:${ChainCap}`
  | "network"
  | "contract"
  | "method"
  | "args"
  | "recipient"
  | "amount"
  | "value"
  | "gas"
  | "template"
  | "ctor"
  | "approval";

export type ResolvedContract = { kind: ContractKind; address: Address; label: string };

export type NormalizedAction =
  | { op: "read"; contract: ResolvedContract; method: string; args: JsonArg[]; callArgs: unknown[]; data: Hex }
  | { op: "events"; contract: ResolvedContract; event: string | null; limit: number }
  | { op: "tx"; hash: Hex }
  | {
      op: "call";
      contract: ResolvedContract;
      method: string;
      /** JSON-safe args (uint as decimal strings, addresses checksummed). */
      args: JsonArg[];
      /** Args typed for viem (bigint for uint). */
      callArgs: unknown[];
      data: Hex;
      gas: bigint | null;
      /** Token amount moved (vault.pay / token.transfer), base units. */
      amountBase: bigint | null;
      recipient: Address | null;
    }
  | {
      op: "deploy";
      template: "escrow";
      artifact: ChainArtifact;
      /** Constructor args in ABI order: token, payer, payee, amount (base units), admin. */
      args: JsonArg[];
      callArgs: [Address, Address, Address, bigint, Address];
      data: Hex;
      amountBase: bigint;
      recipient: Address;
      admin: Address;
    };

export type JsonArg = string | boolean | JsonArg[];

export type ValidationResult = { ok: true; normalized: NormalizedAction } | { ok: false; rule: RuleId; reason: string };

/** What the caller knows beyond the grant. */
export type ValidateContext = {
  /**
   * Addresses allowed as a deployed escrow's admin: the owners of the human
   * levels above the requesting agent (the approver-designated owners). Empty
   * = every deploy is refused.
   */
  admins: Address[];
  /**
   * The requesting agent's branch: the member (human) level it hangs under.
   * A relay-deployed escrow resolves only when it was deployed from inside
   * this branch and its admin is one of `admins`; every escrow shares the
   * relay signer as operator, so without this any agent could release,
   * refund or pause another branch's escrow. Null = no escrow resolves.
   */
  branch: string | null;
  /** Compiled contracts (default: lib/chain/artifacts). */
  artifacts?: { token: ChainArtifact; vault: ChainArtifact; escrow: ChainArtifact };
};

const DEFAULT_ARTIFACTS = { token: CHAIN_ARTIFACTS["relay-token"], vault: CHAIN_ARTIFACTS["relay-vault"], escrow: CHAIN_ARTIFACTS["relay-escrow"] };
const MAX_EVENTS = 100;
const UINT = /^(0|[1-9]\d{0,77})$/;

const deny = (rule: RuleId, reason: string): ValidationResult => ({ ok: false, rule, reason });

/** Which capability an operation needs (call on an escrow additionally needs `manage`). */
export const capFor = (op: ChainAction["op"]): ChainCap => (op === "read" ? "read" : op === "events" || op === "tx" ? "track" : op === "deploy" ? "deploy" : "prepare");

/** Refusal when the grant lacks `cap`, else null. */
export function requireCap(eff: EffectiveGrant | null, cap: ChainCap): { rule: RuleId; reason: string } | null {
  if (!eff) return { rule: "grant", reason: "no blockchain grant" };
  return eff.caps.includes(cap) ? null : { rule: `cap:${cap}`, reason: `this agent's grant doesn't include "${cap}"` };
}

/** Refusal when `gas` exceeds the effective gas cap (or none is set), else null. */
export function checkGas(eff: EffectiveGrant, gas: bigint): { rule: RuleId; reason: string } | null {
  if (eff.gas === null) return { rule: "gas", reason: "no gas limit in the grant: writes are refused" };
  if (gas <= 0n) return { rule: "gas", reason: "gas must be positive" };
  return gas > eff.gas ? { rule: "gas", reason: `gas ${gas} is over the grant's limit of ${eff.gas}` } : null;
}

/** A bytes32 payment reference derived from a request id (for vault.pay's `ref`). */
export const paymentRef = (requestId: string): Hex => keccak256(stringToHex(`relay:pay:${requestId}`));

/** The whole subtree check: `name` is `root` or under it. */
export const inSubtree = (name: string, root: string) => name === root || name.endsWith(`.${root}`);

/** Whether an agent in `ctx.branch` may use (read, track, manage) a relay-deployed escrow. */
export const escrowInBranch = (e: Pick<DeployedEscrow, "deployedBy" | "admin">, ctx: Pick<ValidateContext, "branch" | "admins">) =>
  !!ctx.branch && inSubtree(e.deployedBy, ctx.branch) && ctx.admins.some((a) => isAddress(e.admin, { strict: false }) && isAddressEqual(a, e.admin));

function resolveContract(ref: unknown, ws: ChainWorkspace, deployed: DeployedEscrow[], ctx: ValidateContext): ResolvedContract | string {
  if (ref === "token") return { kind: "token", address: getAddress(ws.token.address), label: ws.token.label };
  if (ref === "vault") return { kind: "vault", address: getAddress(ws.vault.address), label: ws.vault.label };
  if (typeof ref !== "string" || !isAddress(ref, { strict: false })) return `unknown contract ${JSON.stringify(ref)?.slice(0, 60)}: name "token", "vault" or a deployed escrow's address`;
  const a = getAddress(ref);
  if (isAddressEqual(a, ws.token.address)) return { kind: "token", address: a, label: ws.token.label };
  if (isAddressEqual(a, ws.vault.address)) return { kind: "vault", address: a, label: ws.vault.label };
  const e = deployed.find((d) => isAddressEqual(d.address, a));
  if (e) {
    if (!escrowInBranch(e, ctx)) return `escrow ${a} belongs to another branch (deployed by ${e.deployedBy}, admin ${e.admin})`;
    return { kind: "escrow", address: a, label: ws.templates.escrow.label };
  }
  return `${a} is not a workspace contract or a relay-deployed escrow`;
}

const functionsOf = (abi: Abi) => abi.filter((x): x is AbiFunction => x.type === "function");

/** Converts one argument to its ABI type; string error on mismatch. Only the types the workspace contracts use. */
function coerce(p: AbiParameter, v: unknown): { ok: true; call: unknown; json: JsonArg } | { ok: false; why: string } {
  const t = p.type;
  const name = p.name || t;
  if (t === "address") {
    if (typeof v !== "string" || !isAddress(v, { strict: false })) return { ok: false, why: `${name} must be an address` };
    const a = getAddress(v);
    return { ok: true, call: a, json: a };
  }
  if (/^uint(\d+)?$/.test(t)) {
    const bits = Number(t.slice(4) || 256);
    let n: bigint;
    if (typeof v === "bigint") n = v;
    else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
    else if (typeof v === "string" && UINT.test(v)) n = BigInt(v);
    else return { ok: false, why: `${name} must be a non-negative integer (base units)` };
    if (n < 0n || n >= 1n << BigInt(bits)) return { ok: false, why: `${name} is out of range for ${t}` };
    return { ok: true, call: n, json: n.toString() };
  }
  if (t === "bool") {
    if (v === true || v === "true") return { ok: true, call: true, json: true };
    if (v === false || v === "false") return { ok: true, call: false, json: false };
    return { ok: false, why: `${name} must be true or false` };
  }
  if (t === "bytes32") {
    if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) return { ok: false, why: `${name} must be 32 bytes of hex` };
    const h = v.toLowerCase() as Hex;
    return { ok: true, call: h, json: h };
  }
  return { ok: false, why: `${name}: argument type ${t} isn't supported` };
}

function coerceArgs(fn: AbiFunction, args: unknown): { ok: true; call: unknown[]; json: JsonArg[] } | { ok: false; why: string } {
  if (!Array.isArray(args)) return { ok: false, why: "args must be an array" };
  if (args.length !== fn.inputs.length) return { ok: false, why: `${fn.name} takes ${fn.inputs.length} argument(s), got ${args.length}` };
  const call: unknown[] = [];
  const json: JsonArg[] = [];
  for (let i = 0; i < fn.inputs.length; i++) {
    const c = coerce(fn.inputs[i], args[i]);
    if (!c.ok) return c;
    call.push(c.call);
    json.push(c.json);
  }
  return { ok: true, call, json };
}

/** The amount/recipient a write moves, or nulls when it moves no tokens. */
function paymentOf(kind: ContractKind, method: string, call: unknown[]): { recipient: Address | null; amount: bigint | null } {
  if ((kind === "vault" && method === "pay") || (kind === "token" && method === "transfer")) return { recipient: call[0] as Address, amount: call[1] as bigint };
  return { recipient: null, amount: null };
}

function checkPayment(eff: EffectiveGrant, recipient: Address, amount: bigint, rule: "recipient" | "ctor" = "recipient"): ValidationResult | null {
  if (!eff.recipientsSet) return deny(rule, "no approved recipients anywhere above this agent");
  if (!eff.recipients.some((r) => isAddressEqual(r, recipient))) return deny(rule, `${recipient} is not an approved recipient`);
  const amtRule = rule === "ctor" ? "ctor" : "amount";
  if (amount <= 0n) return deny(amtRule, "amount must be more than zero");
  if (eff.maxBase === null) return deny(amtRule, "no per-transaction maximum in the grant: payments are refused");
  if (amount > eff.maxBase) return deny(amtRule, `${formatAmount(amount, eff.decimals)} STD is over the per-transaction maximum of ${formatAmount(eff.maxBase, eff.decimals)} STD`);
  return null;
}

/**
 * Validates a typed action. `eff` null = no blockchain grant. `deployed` =
 * relay-deployed escrows (the only addresses beyond token/vault an action may target).
 */
export function validateAction(req: ChainAction, eff: EffectiveGrant | null, ws: ChainWorkspace, deployed: DeployedEscrow[], ctx: ValidateContext): ValidationResult {
  if (!eff) return deny("grant", "no blockchain grant");
  if (!req || typeof req !== "object" || typeof (req as { op?: unknown }).op !== "string") return deny("args", "malformed request");
  const op = req.op;
  if (!["read", "events", "tx", "call", "deploy"].includes(op)) return deny("args", `unknown operation ${JSON.stringify(op).slice(0, 40)}`);

  const capMiss = requireCap(eff, capFor(op));
  if (capMiss) return deny(capMiss.rule, capMiss.reason);

  const network = req.network ?? ws.network.name;
  if (network !== ws.network.name) return deny("network", `network ${JSON.stringify(network).slice(0, 40)} isn't this workspace's (${ws.network.name})`);
  if (!(eff.net as string[]).includes(network)) return deny("network", `the grant doesn't include ${network}`);

  const arts = ctx.artifacts ?? DEFAULT_ARTIFACTS;

  if (op === "tx") {
    if (typeof req.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(req.hash)) return deny("args", "hash must be a 32-byte transaction hash");
    return { ok: true, normalized: { op, hash: req.hash.toLowerCase() as Hex } };
  }

  if (op === "deploy") return validateDeploy(req, eff, ws, arts, ctx);

  const resolved = resolveContract(req.contract, ws, deployed, ctx);
  if (typeof resolved === "string") return deny("contract", resolved);
  if (!eff.contracts.includes(resolved.kind)) return deny("contract", `the grant doesn't include the ${resolved.kind} contract`);
  const abi = arts[resolved.kind].abi;

  if (op === "events") {
    let event: string | null = null;
    if (req.event !== undefined) {
      if (typeof req.event !== "string" || !abi.some((x) => x.type === "event" && x.name === req.event)) return deny("method", `${resolved.kind} has no event ${JSON.stringify(req.event).slice(0, 60)}`);
      event = req.event;
    }
    const limit = req.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS) return deny("args", `limit must be 1–${MAX_EVENTS}`);
    return { ok: true, normalized: { op, contract: resolved, event, limit } };
  }

  if (typeof req.method !== "string") return deny("method", "method must be a string");
  const fns = functionsOf(abi).filter((f) => f.name === req.method);
  if (fns.length !== 1) return deny("method", `${resolved.kind} has no function ${JSON.stringify(req.method).slice(0, 60)}`);
  const fn = fns[0];
  const isView = fn.stateMutability === "view" || fn.stateMutability === "pure";

  if (op === "read") {
    if (!isView) return deny("method", `${resolved.kind}.${fn.name} changes state; reads may only call view functions`);
    const a = coerceArgs(fn, req.args);
    if (!a.ok) return deny("args", a.why);
    const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: a.call });
    return { ok: true, normalized: { op, contract: resolved, method: fn.name, args: a.json, callArgs: a.call, data } };
  }

  // op === "call": a write.
  if (isView) return deny("method", `${resolved.kind}.${fn.name} is a view function: use read`);
  if (resolved.kind === "escrow") {
    const m = requireCap(eff, "manage");
    if (m) return deny(m.rule, m.reason);
  }
  if (!WRITE_METHODS[resolved.kind].includes(fn.name)) return deny("method", `${resolved.kind}.${fn.name} is never delegated to agents`);
  if (!eff.methods[resolved.kind].includes(fn.name)) return deny("method", `the grant doesn't allow ${resolved.kind}.${fn.name}`);
  const a = coerceArgs(fn, req.args);
  if (!a.ok) return deny("args", a.why);
  if (req.value !== undefined && !(req.value === "0" || req.value === "")) return deny("value", "sending ETH with a call is refused");
  let gas: bigint | null = null;
  if (req.gas !== undefined) {
    if (typeof req.gas !== "string" || !UINT.test(req.gas)) return deny("gas", "gas must be a decimal integer");
    gas = BigInt(req.gas);
    const g = checkGas(eff, gas);
    if (g) return deny(g.rule, g.reason);
  } else if (eff.gas === null) return deny("gas", "no gas limit in the grant: writes are refused");

  const pay = paymentOf(resolved.kind, fn.name, a.call);
  if (pay.recipient !== null && pay.amount !== null) {
    const bad = checkPayment(eff, pay.recipient, pay.amount);
    if (bad) return bad;
  }
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: a.call });
  return {
    ok: true,
    normalized: { op, contract: resolved, method: fn.name, args: a.json, callArgs: a.call, data, gas, amountBase: pay.amount, recipient: pay.recipient },
  };
}

function validateDeploy(
  req: Extract<ChainAction, { op: "deploy" }>,
  eff: EffectiveGrant,
  ws: ChainWorkspace,
  arts: NonNullable<ValidateContext["artifacts"]>,
  ctx: ValidateContext,
): ValidationResult {
  if (req.template !== "escrow") return deny("template", `unknown template ${JSON.stringify(req.template).slice(0, 40)}`);
  if (!eff.contracts.includes("escrow")) return deny("contract", "the grant doesn't include escrow contracts");
  const t = ws.templates?.escrow;
  const art = arts.escrow;
  if (!t) return deny("template", "no approved escrow template in the workspace");
  if (!t.networks.includes(ws.network.name)) return deny("template", `the escrow template isn't approved for ${ws.network.name}`);
  const actualBytecodeHash = keccak256(art.bytecode);
  if (actualBytecodeHash !== art.bytecodeHash || t.bytecodeHash.toLowerCase() !== actualBytecodeHash.toLowerCase())
    return deny("template", `escrow bytecode hash ${actualBytecodeHash.slice(0, 10)}… doesn't match the approved template ${String(t.bytecodeHash).slice(0, 10)}…`);
  if (t.abiHash.toLowerCase() !== art.abiHash.toLowerCase()) return deny("template", "escrow ABI hash doesn't match the approved template");
  if (eff.gas === null) return deny("gas", "no gas limit in the grant: deploys are refused");

  const args = req.args as Record<string, unknown> | undefined;
  if (!args || typeof args !== "object") return deny("args", "deploy needs {payer, payee, amount, admin}");
  const known = ["payer", "payee", "amount", "admin", "token"];
  const extra = Object.keys(args).find((k) => !known.includes(k));
  if (extra) return deny("args", `unknown constructor field ${JSON.stringify(extra).slice(0, 40)}`);
  const addr = (k: string): Address | null => (typeof args[k] === "string" && isAddress(args[k] as string, { strict: false }) ? getAddress(args[k] as string) : null);
  const payer = addr("payer");
  const payee = addr("payee");
  const admin = addr("admin");
  if (!payer || !payee || !admin) return deny("args", "payer, payee and admin must be addresses");
  const token = getAddress(ws.token.address);
  if (args.token !== undefined) {
    const tk = addr("token");
    if (!tk || !isAddressEqual(tk, token)) return deny("ctor", "the escrow token must be the workspace token");
  }
  for (const [k, a] of [["payer", payer], ["payee", payee], ["admin", admin]] as const) if (isAddressEqual(a, zeroAddress)) return deny("ctor", `${k} can't be the zero address`);
  const amountBase = parseAmount(args.amount, eff.decimals);
  if (amountBase === null) return deny("args", "amount must be a decimal STD amount, e.g. \"3\"");

  if (isAddressEqual(admin, ws.signer)) return deny("ctor", "the escrow admin can't be the relay signer");
  if (!ctx.admins.some((a) => isAddressEqual(a, admin))) return deny("ctor", `admin ${admin} is not an owner above this agent`);
  if (!isAddressEqual(payer, ws.vault.address) && !isAddressEqual(payer, admin)) return deny("ctor", "payer must be the vault or the admin");
  const bad = checkPayment(eff, payee, amountBase, "ctor");
  if (bad) return bad;

  const callArgs: [Address, Address, Address, bigint, Address] = [token, payer, payee, amountBase, admin];
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: callArgs });
  return {
    ok: true,
    normalized: { op: "deploy", template: "escrow", artifact: art, args: [token, payer, payee, amountBase.toString(), admin], callArgs, data, amountBase, recipient: payee, admin },
  };
}
