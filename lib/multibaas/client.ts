// A small typed MultiBaas REST client (api/v0) over fetch: no SDK, no dependencies.
//
// Every answer is the envelope `{status, message, result}`; the client unwraps it in one place
// and throws `MultiBaasError` for anything else. The API key is only ever put in the
// Authorization header, never in a URL or an error message. `multibaasFromConfig()` reads the
// deployment URL and key per call (MULTIBAAS_URL / MULTIBAAS_API_KEY through the relay config),
// so keys saved in the credential store apply without a restart.

import { type Address, type Hex, type LocalAccount, getAddress, isAddress, isAddressEqual, keccak256 } from "viem";

import { getConfig } from "../relay/config";
import type {
  MbAddress,
  MbBlock,
  MbCallResult,
  MbChainStatus,
  MbContract,
  MbContractOverview,
  MbContractUpload,
  MbDeploy,
  MbEnvelope,
  MbEvent,
  MbEventFilter,
  MbIndexingStatus,
  MbMethodArgs,
  MbPlan,
  MbReceipt,
  MbSubmitted,
  MbTransaction,
  MbTx,
  ReceiptSummary,
} from "./types";

export type * from "./types";

/** MultiBaas's request timeout. */
export const MB_TIMEOUT_MS = 20_000;

/**
 * A failed MultiBaas call. `status` is the HTTP status (0 when no answer came back);
 * `kind` tells an answer MultiBaas refused ("http") from one that never arrived
 * ("network" / "timeout": for a submit, the transaction may or may not have been broadcast).
 */
export class MultiBaasError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly path: string,
    readonly kind: "http" | "network" | "timeout" | "invalid" = "http",
    /** MultiBaas answered with a non-2xx status AND a parsed error envelope: an explicit refusal. */
    readonly refused = false,
  ) {
    super(`MultiBaas ${path}: ${message}${status ? ` (${status})` : ""}`);
    this.name = "MultiBaasError";
  }
}

export type MultiBaasOptions = {
  /** Deployment URL, e.g. "https://abc123.multibaas.com" (a trailing "/api/v0" is fine). A function is read per call. */
  url: string | (() => string | null);
  /** API key (Bearer). A function is read per call. */
  key: string | (() => string | null);
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/** Where a contract lives: a 0x address or a MultiBaas alias. */
export type AddressOrAlias = Address | string;

export type CallOptions = Omit<MbMethodArgs, "args"> & { args?: unknown[] };

/** How `createContract` went: uploaded now, or already there with the same bytecode. */
export type UploadOutcome = "created" | "exists";

// MultiBaas label/alias pattern (lowercase, digits, _ and -; no leading "0x").
const LABEL = /^(?:[a-z1-9_-][a-z0-9_-]*|0(?:[a-wyz0-9_-][a-z0-9_-]*)?)$/;
const METHOD = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** "https://x.multibaas.com/api/v0/" -> "https://x.multibaas.com/api/v0". */
export function apiBase(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("MultiBaas URL must be http(s)");
  if (u.username || u.password) throw new Error("MultiBaas URL must not carry credentials");
  return `${u.origin}${u.pathname.replace(/\/+$/, "").replace(/\/api\/v0$/, "")}/api/v0`;
}

function label(kind: string, v: string): string {
  if (typeof v !== "string" || v.length > 64 || !LABEL.test(v)) throw new MultiBaasError(0, `bad ${kind} "${String(v).slice(0, 40)}"`, "(local)", "invalid");
  return v;
}

function addrOrAlias(v: string): string {
  if (typeof v === "string" && isAddress(v, { strict: false })) return getAddress(v);
  return label("alias", v);
}

function version(v: string): string {
  if (typeof v !== "string" || !v || v.length > 32 || /["#$%&'()*+,/:;<>?[\\\]^`{}~\s]/.test(v)) {
    throw new MultiBaasError(0, `bad version "${String(v).slice(0, 20)}"`, "(local)", "invalid");
  }
  return encodeURIComponent(v);
}

function txHash(v: string): Hex {
  if (typeof v !== "string" || !HASH.test(v)) throw new MultiBaasError(0, "bad transaction hash", "(local)", "invalid");
  return v.toLowerCase() as Hex;
}

const pick = (v: string | (() => string | null)) => (typeof v === "function" ? v() : v);

/** A MultiBaas client. Paths are validated locally; the key is read per call. */
export function multibaas(opts: MultiBaasOptions) {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? MB_TIMEOUT_MS;

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, query?: URLSearchParams): Promise<{ status: number; result: T }> {
    const url = pick(opts.url);
    const key = pick(opts.key);
    if (!url) throw new MultiBaasError(0, "MULTIBAAS_URL is not set", path, "invalid");
    if (!key) throw new MultiBaasError(0, "MULTIBAAS_API_KEY is not set", path, "invalid");
    let base: string;
    try {
      base = apiBase(url);
    } catch (e) {
      throw new MultiBaasError(0, (e as Error).message, path, "invalid");
    }
    const redact = (s: string) => s.split(key).join("[redacted]");
    const qs = query && [...query.keys()].length ? `?${query}` : "";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}${qs}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      const err = e as Error;
      const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new MultiBaasError(0, timeout ? `no answer in ${timeoutMs / 1000}s` : redact(`unreachable: ${err?.message ?? String(e)}`).slice(0, 200), path, timeout ? "timeout" : "network");
    }
    const text = await res.text().catch(() => "");
    let env: MbEnvelope<T> | null = null;
    try {
      env = JSON.parse(text) as MbEnvelope<T>;
    } catch {
      env = null;
    }
    if (!res.ok || !env || typeof env !== "object" || env.message !== "success") {
      const msg = env && typeof env.message === "string" ? env.message : res.ok ? "unexpected answer" : res.statusText || "error";
      const refused = !res.ok && !!env && typeof env === "object" && typeof env.message === "string";
      throw new MultiBaasError(res.status, redact(msg).replace(/[\u0000-\u001f]/g, " ").slice(0, 300), path, "http", refused);
    }
    return { status: res.status, result: env.result as T };
  }

  const get = async <T>(path: string, query?: URLSearchParams) => (await request<T>("GET", path, undefined, query)).result;
  const post = async <T>(path: string, body: unknown) => (await request<T>("POST", path, body)).result;
  /** GET that maps 404 to null (get-or-create flows, pending receipts). */
  const find = async <T>(path: string, query?: URLSearchParams): Promise<T | null> => {
    try {
      return await get<T>(path, query);
    } catch (e) {
      if (e instanceof MultiBaasError && e.status === 404) return null;
      throw e;
    }
  };

  const client = {
    /** GET /chains/ethereum/status: chain id and head block. */
    status: async () => get<MbChainStatus>("/chains/ethereum/status"),

    /** GET /plan (admin key): the deployment's limits and features. */
    plan: async () => get<MbPlan>("/plan"),

    /** GET /contracts: every uploaded label. */
    listContracts: async () => get<MbContractOverview[]>("/contracts"),

    /** GET /contracts/{label}[/{version}]; null when absent. */
    getContract: async (lbl: string, ver?: string) =>
      find<MbContract>(ver === undefined ? `/contracts/${label("label", lbl)}` : `/contracts/${label("label", lbl)}/${version(ver)}`),

    /**
     * Idempotent upload: "exists" when the label+version is already there with the same bytecode,
     * "created" after uploading it, and an error (409) when it exists with different bytecode.
     */
    async createContract(lbl: string, c: MbContractUpload): Promise<UploadOutcome> {
      const bin = c.bin.toLowerCase() as Hex;
      const existing = await client.getContract(lbl, c.version);
      if (existing) {
        if ((existing.bin ?? "").toLowerCase() === bin) return "exists";
        throw new MultiBaasError(409, `${lbl} ${c.version} is already uploaded with different bytecode; bump the version`, `/contracts/${lbl}/${c.version}`);
      }
      const rawAbi = typeof c.rawAbi === "string" ? c.rawAbi : JSON.stringify(c.rawAbi);
      await request("POST", `/contracts/${label("label", lbl)}`, { label: lbl, contractName: c.contractName, version: c.version, rawAbi, bin });
      return "created";
    },

    /** GET /chains/ethereum/addresses/{a}; `alias` is "" for an address without one; null when an alias is unknown. */
    getAddress: async (a: AddressOrAlias, include: ("balance" | "nonce" | "code")[] = []) =>
      find<MbAddress>(`/chains/ethereum/addresses/${addrOrAlias(a)}`, new URLSearchParams(include.map((i) => ["include", i]))),

    /** POST /chains/ethereum/addresses: create or move an alias. */
    setAlias: async (address: Address, alias: string) =>
      post<MbAddress>("/chains/ethereum/addresses", { address: getAddress(address), alias: label("alias", alias) }),

    /** Links an address to an uploaded label. Without `startingBlock` MultiBaas doesn't index events. */
    link: async (a: AddressOrAlias, l: { label: string; version?: string; startingBlock?: string }) => {
      if (l.startingBlock !== undefined && !/^(latest|-?\d{1,12})$/.test(l.startingBlock)) {
        throw new MultiBaasError(0, "bad startingBlock", "(local)", "invalid");
      }
      return post<MbAddress>(`/chains/ethereum/addresses/${addrOrAlias(a)}/contracts`, {
        label: label("label", l.label),
        ...(l.version === undefined ? {} : { version: l.version }),
        ...(l.startingBlock === undefined ? {} : { startingBlock: l.startingBlock }),
      });
    },

    /** Event indexing progress for a linked contract; null when not linked. */
    indexingStatus: async (a: AddressOrAlias, lbl: string) =>
      find<MbIndexingStatus>(`/chains/ethereum/addresses/${addrOrAlias(a)}/contracts/${label("label", lbl)}/status`),

    /**
     * Calls a method: a view returns `{kind:"MethodCallResponse", output}`, a write returns the unsigned
     * `{kind:"TransactionToSignResponse", tx}` (nothing is sent). Integers come back as decimal strings.
     */
    async call(a: AddressOrAlias, lbl: string, method: string, o: CallOptions = {}): Promise<MbCallResult> {
      if (!METHOD.test(method)) throw new MultiBaasError(0, "bad method name", "(local)", "invalid");
      // No `gas`: the live API refuses it ("unknown field gas") although the published spec lists it.
      // MultiBaas estimates; the relay signs with the gas limit it approved, not MultiBaas's estimate.
      const { gas: _gas, ...rest } = o;
      const r = await post<MbCallResult>(`/chains/ethereum/addresses/${addrOrAlias(a)}/contracts/${label("label", lbl)}/methods/${method}`, {
        formatInts: "as_strings",
        ...rest,
        args: o.args ?? [],
      });
      if (!r || (r.kind !== "MethodCallResponse" && r.kind !== "TransactionToSignResponse")) {
        throw new MultiBaasError(200, "unexpected call result", `/methods/${method}`);
      }
      return r;
    },

    /** Reads a view function and returns its output (throws when MultiBaas composed a transaction instead). */
    async read(a: AddressOrAlias, lbl: string, method: string, args: unknown[] = [], o: Omit<CallOptions, "args"> = {}): Promise<unknown> {
      const r = await client.call(a, lbl, method, { ...o, args });
      if (r.kind !== "MethodCallResponse") throw new MultiBaasError(200, `${method} is not a view function`, `/methods/${method}`);
      return r.output;
    },

    /** Composes an unsigned write transaction from `from` (nothing is sent). */
    async prepare(a: AddressOrAlias, lbl: string, method: string, o: CallOptions & { from: Address }): Promise<MbTx> {
      const r = await client.call(a, lbl, method, o);
      if (r.kind !== "TransactionToSignResponse") throw new MultiBaasError(200, `${method} did not compose a transaction`, `/methods/${method}`);
      return r.tx;
    },

    /** Composes an unsigned deploy of an uploaded label+version; `deployAt` is where it lands with MultiBaas's nonce. */
    async deploy(lbl: string, ver: string, o: { args: unknown[]; from: Address; gas?: number }): Promise<MbDeploy> {
      const { gas: _gas, ...rest } = o; // not sent: see call()
      const r = await post<MbDeploy>(`/contracts/${label("label", lbl)}/${version(ver)}/deploy`, { formatInts: "as_strings", ...rest });
      if (!r?.tx || r.tx.to) throw new MultiBaasError(200, "unexpected deploy result", `/contracts/${lbl}/deploy`);
      return r;
    },

    /** Composes an unsigned ETH transfer (wei, decimal string). */
    async transferEth(from: Address, to: Address, valueWei: string): Promise<MbTx> {
      if (!/^\d+$/.test(valueWei)) throw new MultiBaasError(0, "bad value", "(local)", "invalid");
      const r = await post<{ tx: MbTx } | MbTx>("/chains/ethereum/transfers", { from: getAddress(from), to: getAddress(to), value: valueWei });
      const tx = r && "tx" in r && r.tx ? r.tx : (r as MbTx);
      if (!tx || typeof tx.nonce !== "number") throw new MultiBaasError(200, "unexpected transfer result", "/chains/ethereum/transfers");
      return tx;
    },

    /** Broadcasts a signed transaction; returns after broadcast, not after mining. */
    async submit(signedTx: Hex): Promise<{ hash: Hex; tx: MbSubmitted["tx"] }> {
      if (!/^0x[0-9a-fA-F]+$/.test(signedTx)) throw new MultiBaasError(0, "bad signed transaction", "(local)", "invalid");
      const r = await post<MbSubmitted>("/chains/ethereum/transactions/submit", { signedTx });
      if (!r?.tx?.hash) throw new MultiBaasError(200, "submit returned no hash", "/chains/ethereum/transactions/submit");
      return { hash: r.tx.hash.toLowerCase() as Hex, tx: r.tx };
    },

    /** A transaction (pending or mined); null when unknown. */
    tx: async (hash: Hex) => find<MbTransaction>(`/chains/ethereum/transactions/${txHash(hash)}`),

    /** A mined transaction's receipt; null while pending or unknown. */
    receipt: async (hash: Hex) => find<MbReceipt>(`/chains/ethereum/transactions/receipt/${txHash(hash)}`),

    /** A block by number, hash or "latest". */
    block: async (n: number | "latest" | Hex) => {
      const id = n === "latest" ? n : typeof n === "number" ? (Number.isSafeInteger(n) && n >= 0 ? String(n) : null) : HASH.test(n) ? n.toLowerCase() : null;
      if (id === null) throw new MultiBaasError(0, "bad block id", "(local)", "invalid");
      return get<MbBlock>(`/chains/ethereum/blocks/${id}`);
    },

    /** GET /events (indexed contracts only; exact block filter; `limit` defaults to 10 upstream). */
    events: async (f: MbEventFilter = {}) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== null) q.set(k, String(v));
      return get<MbEvent[]>("/events", q);
    },

    /** ETH balance in wei. */
    async balance(a: Address): Promise<bigint> {
      const r = await client.getAddress(a, ["balance"]);
      if (!r || typeof r.balance !== "string" || !/^\d+$/.test(r.balance)) throw new MultiBaasError(200, "no balance in answer", "/chains/ethereum/addresses");
      return BigInt(r.balance);
    },

    /**
     * ERC-20 balance in base units, through our own `relay-token` label (no link needed). Not the stock
     * `erc20interface` label: deployments can attach decimal type conversions to it ("0.000000000000000000").
     */
    async tokenBalance(token: Address, holder: Address, label = "relay-token"): Promise<bigint> {
      const out = await client.read(token, label, "balanceOf", [getAddress(holder)], { contractOverride: true });
      return toBigInt(out, "balanceOf");
    },
  };
  return client;
}

export type MultiBaas = ReturnType<typeof multibaas>;

/** The relay's MultiBaas client: URL and key come from the relay config on every call. */
export function multibaasFromConfig(o: { fetch?: typeof fetch; timeoutMs?: number } = {}): MultiBaas {
  return multibaas({ ...o, url: () => getConfig().upstreams.multibaas, key: () => getConfig().keyFor("multibaas") });
}

/** A decimal-string / number output as bigint (throws on anything else). */
export function toBigInt(v: unknown, what = "value"): bigint {
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new MultiBaasError(200, `${what} is not an integer`, "(decode)");
}

/** Hex/decimal quantity -> number (receipts use hex, blocks decimal strings). */
export function quantity(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v) ? Number(BigInt(v)) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new MultiBaasError(200, "bad quantity", "(decode)");
  return n;
}

/** A receipt reduced to what the relay tracks. */
export function summarizeReceipt(r: MbReceipt): ReceiptSummary {
  const d = r.data;
  return {
    hash: d.transactionHash.toLowerCase() as Hex,
    blockNumber: quantity(d.blockNumber),
    blockHash: d.blockHash.toLowerCase() as Hex,
    status: BigInt(d.status) === 1n ? "success" : "reverted",
    contractAddress: d.contractAddress && isAddress(d.contractAddress, { strict: false }) && BigInt(d.contractAddress) !== 0n ? getAddress(d.contractAddress) : null,
  };
}

/** A transaction signed locally, ready for `submit`. `hash` = keccak256(serialized), known before broadcast. */
export type SignedMbTx = { serialized: Hex; hash: Hex; nonce: number };

/**
 * Signs an unsigned MultiBaas transaction with a local account (viem). Type 2 maps gasFeeCap/gasTipCap
 * to maxFeePerGas/maxPriorityFeePerGas, type 0 uses gasPrice; decimal strings become bigint; MultiBaas's
 * `hash` and `from` are dropped (from must be this account); "" data becomes "0x"; a null `to` is a deploy.
 */
export async function signMbTx(account: LocalAccount, tx: MbTx, chainId: number): Promise<SignedMbTx> {
  const bad = (m: string) => new MultiBaasError(0, `cannot sign: ${m}`, "(sign)", "invalid");
  if (!account.signTransaction) throw bad("account can't sign transactions");
  if (!tx || typeof tx !== "object") throw bad("no transaction");
  if (!tx.from || !isAddress(tx.from, { strict: false }) || !isAddressEqual(tx.from, account.address)) throw bad("transaction is not from this signer");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw bad("bad chain id");
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) throw bad("bad nonce");
  if (!Number.isSafeInteger(tx.gas) || tx.gas <= 0) throw bad("bad gas");
  const dec = (v: unknown, what: string) => {
    if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
    if (typeof v !== "string" || !/^\d+$/.test(v)) throw bad(`bad ${what}`);
    return BigInt(v);
  };
  const data = (tx.data === "" || tx.data === undefined || tx.data === null ? "0x" : tx.data.toLowerCase()) as Hex;
  if (!/^0x([0-9a-f]{2})*$/.test(data)) throw bad("bad data");
  let to: Address | undefined;
  if (tx.to !== null && tx.to !== undefined) {
    if (!isAddress(tx.to, { strict: false })) throw bad("bad to");
    to = getAddress(tx.to);
  }
  const base = { chainId, nonce: tx.nonce, to, data, value: dec(tx.value ?? "0", "value"), gas: BigInt(tx.gas) };
  let serialized: Hex;
  if (tx.type === 2) {
    serialized = await account.signTransaction({ ...base, type: "eip1559", maxFeePerGas: dec(tx.gasFeeCap, "gasFeeCap"), maxPriorityFeePerGas: dec(tx.gasTipCap, "gasTipCap") });
  } else if (tx.type === 0) {
    serialized = await account.signTransaction({ ...base, type: "legacy", gasPrice: dec(tx.gasPrice, "gasPrice") });
  } else {
    throw bad(`unsupported transaction type ${String(tx.type)}`);
  }
  return { serialized, hash: keccak256(serialized), nonce: tx.nonce };
}
