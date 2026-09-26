// The gas funder (POST /api/fund): tops up a new member's wallet with a little
// Sepolia ETH so they can create their own agents, without anyone sending it
// by hand.
//
// It needs no sign-in; the chain is the check. A name is funded only when:
// - it is under RELAY_ROOT_NAME and every level down to it is registered
//   (and genuine and canonical, the same checks the relay makes on every call)
// - it is a member: every level above it, from the company down, is held by the
//   company owner (the one who adds people), and the member itself is held by
//   someone else, not the funder. Checking only the level directly above isn't
//   enough: a member holds every role on its own registry, and ENSv2 lets anyone
//   register a name to any address, so a member could put a name held by the
//   company owner under itself and hang more names below that. Agents (held by
//   their member) are never funded: only the member's wallet pays gas, and this
//   stops a member from farming ETH by minting agents.
// - its owner's balance is below FUNDER_MIN_BALANCE_ETH
// - it wasn't funded before under the same registration (name + EAC resource,
//   so a removed and re-added member can be funded again)
// - the day's total stays within FUNDER_DAILY_LIMIT_ETH (UTC days)
// Grants are recorded in the meter file. Sends are serialized so two requests
// can never pay twice or race on the funder's nonce. The key never leaves
// config.funder.account().
//
// Rate limits: every request takes a per-client token (it costs chain reads);
// only a request that passed every check takes a grant token, keyed by the
// owner address, so refused requests can't use up the shared grant budget.

import {
  type Address,
  type Hex,
  type PublicClient,
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  keccak256,
  parseEther,
} from "viem";
import { sepolia } from "viem/chains";

import { tryNormalize } from "../ens/names";
import { type RelayConfig, applyDnsAlias } from "./config";
import { isChainReadError } from "./ens";
import type { Meter } from "./meter";
import { type PolicyDeps, decide } from "./policy";
import { type RelayLimits, clientKey, relayLimits } from "./ratelimit";
import type { FundResponse } from "./types";

export type FunderWallet = {
  address: Address;
  getBalance: (address: Address) => Promise<bigint>;
  /** Sends `value` wei to `to`; resolves with the transaction hash once it is broadcast. */
  send: (to: Address, value: bigint) => Promise<Hex>;
  /** Waits for the transaction to be mined (best effort, bounded). */
  confirm?: (hash: Hex) => Promise<void>;
};

export type FundDeps = PolicyDeps & { wallet: FunderWallet | null; limits?: RelayLimits };

type FundState = { inFlight: Map<string, bigint>; queue: Promise<unknown> };
const g = globalThis as unknown as { __relayFund?: WeakMap<Meter, FundState>; __relayFunders?: Map<string, FunderWallet> };

function stateFor(meter: Meter): FundState {
  g.__relayFund ??= new WeakMap();
  let s = g.__relayFund.get(meter);
  if (!s) g.__relayFund.set(meter, (s = { inFlight: new Map(), queue: Promise.resolve() }));
  return s;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const reply = (status: number, body: FundResponse) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const shortError = (err: unknown) => {
  const e = err as { shortMessage?: string; message?: string };
  return (e?.shortMessage || e?.message || String(err)).split("\n")[0];
};

export async function handleFund(request: Request, deps: FundDeps): Promise<Response> {
  const { config, meter, wallet } = deps;
  const limits = deps.limits ?? relayLimits();
  const notFunded = (status: number, reason: string, address: Address | null = null) => reply(status, { funded: false, address, reason });

  if (!wallet) return notFunded(503, config.funder.error ?? "The relay has no funder wallet (set FUNDER_PRIVATE_KEY).");

  let input: { name?: unknown; address?: unknown };
  try {
    input = await request.json();
  } catch {
    return notFunded(400, 'Send JSON: {"name": "<your ENS name>"}');
  }
  const rawName = typeof input?.name === "string" ? input.name.trim() : "";
  if (!rawName) return notFunded(400, 'Send JSON: {"name": "<your ENS name>"}');
  const normalized = tryNormalize(rawName);
  if (!normalized) return notFunded(400, `"${rawName}" is not a valid ENS name`);
  let expected: Address | null = null;
  if (input.address !== undefined && input.address !== null) {
    if (typeof input.address !== "string" || !isAddress(input.address, { strict: false })) return notFunded(400, "address is not an address");
    expected = getAddress(input.address);
  }
  const name = applyDnsAlias(normalized, config.dnsAlias);
  const root = config.rootName;
  if (!root) return notFunded(503, config.rootError ?? "The relay has no root name (set RELAY_ROOT_NAME).");
  if (name === root || !name.endsWith(`.${root}`)) return notFunded(403, `${name} is not a member of ${root}`);
  if (!limits.fundChecks.take(clientKey(request.headers))) return notFunded(429, "Too many funding requests. Try again in a minute.");

  // Every level registered, genuine and canonical; no provider = ownership and chain checks only.
  let levels;
  try {
    const d = await decide({ name, provider: null }, deps);
    if (d.denial !== "unknown-provider") return notFunded(d.denial === "root-mismatch" || d.denial === "no-root" ? 503 : 403, d.reason ?? "refused");
    levels = d.levels;
  } catch (err) {
    return notFunded(502, isChainReadError(err) ? err.message : "could not read ENS");
  }
  const leaf = levels[levels.length - 1];
  const company = levels[0];
  const owner = leaf.owner;
  if (!owner) return notFunded(403, `${name} has no owner`);
  if (isAddressEqual(owner, wallet.address)) return notFunded(403, `${name} is held by the funder itself`, owner);
  if (company.owner && isAddressEqual(owner, company.owner)) return notFunded(403, `${name} is held by the company owner; only members are funded`, owner);
  const outsider = levels.slice(0, -1).find((l) => !l.owner || !company.owner || !isAddressEqual(l.owner, company.owner));
  if (outsider) return notFunded(403, `only members added by the company are funded; ${outsider.name} is not held by the company owner`, owner);
  if (expected && !isAddressEqual(expected, owner)) return notFunded(403, `owner mismatch: ${name} is held by ${owner}, not ${expected}`, owner);

  const why = meter.unavailable();
  if (why) return notFunded(503, `${why}. Funding is paused until grants can be recorded.`, owner);

  const resource = leaf.resource ?? "0";
  const grantKey = `${name}|${resource}`;
  const state = stateFor(meter);
  const fundedBefore = () => state.inFlight.has(grantKey) || meter.hasGrant(name, resource);
  if (fundedBefore()) return notFunded(200, "already funded", owner);

  const amount = parseEther(config.funder.amountEth);
  let balance: bigint;
  try {
    balance = await wallet.getBalance(owner);
  } catch (err) {
    return notFunded(502, `could not read the balance of ${owner}: ${shortError(err)}`, owner);
  }
  if (balance >= parseEther(config.funder.minBalanceEth)) {
    return notFunded(200, `${owner} already has ${formatEther(balance)} ETH (tops up below ${config.funder.minBalanceEth})`, owner);
  }

  // No await from here until the grant is held: the checks and the hold happen together.
  if (fundedBefore()) return notFunded(200, "already funded", owner);
  if (!limits.fund.take(owner.toLowerCase())) return notFunded(429, "Too many top-ups right now. Try again in a minute.", owner);
  const today = utcDay(Date.now());
  const spentToday =
    meter.grants().reduce((sum, gr) => (utcDay(gr.ts) === today ? sum + BigInt(gr.amountWei) : sum), 0n) +
    [...state.inFlight.values()].reduce((a, b) => a + b, 0n);
  const limit = parseEther(config.funder.dailyLimitEth);
  if (spentToday + amount > limit) {
    return notFunded(429, `the funder's daily limit (${config.funder.dailyLimitEth} ETH) is used up; try again tomorrow (UTC)`, owner);
  }
  state.inFlight.set(grantKey, amount);

  // One send at a time: the funder's nonce comes from the chain for each transaction.
  const send = state.queue.then(() => wallet.send(owner, amount));
  state.queue = send.catch(() => {});
  let txHash: Hex;
  try {
    txHash = await send;
  } catch (err) {
    state.inFlight.delete(grantKey);
    return notFunded(502, `the funder couldn't send: ${shortError(err)}`, owner);
  }
  meter.addGrant({ name, resource, address: owner, amountWei: amount.toString(), txHash, ts: Date.now() });
  state.inFlight.delete(grantKey);
  await meter.flush();
  // Wait for it to be mined so the member can spend it right away (bounded; the hash is returned either way).
  await wallet.confirm?.(txHash).catch(() => {});
  return reply(200, { funded: true, address: owner, amountEth: config.funder.amountEth, txHash });
}

/** Public Sepolia nodes a signed top-up is also offered to when the configured RPC refuses it. */
const BROADCAST_FALLBACK_RPCS = ["https://sepolia.gateway.tenderly.co", "https://ethereum-sepolia-rpc.publicnode.com"];

/** The funder wallet for this config, or null without FUNDER_PRIVATE_KEY. Reused per RPC URL and address. */
export function funderWallet(config: RelayConfig): FunderWallet | null {
  const address = config.funder.address;
  if (!address) return null;
  const cacheKey = `${config.rpcUrl}|${address}`;
  g.__relayFunders ??= new Map();
  const cached = g.__relayFunders.get(cacheKey);
  if (cached) return cached;
  const account = config.funder.account();
  if (!account) return null;
  const client = (url: string) => createPublicClient({ chain: sepolia, transport: http(url, { timeout: 30_000 }) }) as PublicClient;
  const reader = client(config.rpcUrl);
  // Signed here and sent raw, to the configured RPC first and then to public nodes: some hosted
  // RPCs refuse valid raw transactions, and viem's wallet path adds an eth_fillTransaction round trip.
  const broadcasters = [reader, ...BROADCAST_FALLBACK_RPCS.filter((url) => url !== config.rpcUrl).map(client)];
  const wallet: FunderWallet = {
    address: account.address,
    getBalance: (a) => reader.getBalance({ address: a }),
    send: async (to, value) => {
      const [nonce, fees, gas] = await Promise.all([
        reader.getTransactionCount({ address: account.address, blockTag: "pending" }),
        reader.estimateFeesPerGas(),
        reader.estimateGas({ account: account.address, to, value }),
      ]);
      const signed = await account.signTransaction({
        chainId: sepolia.id,
        type: "eip1559",
        to,
        value,
        nonce,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const hash = keccak256(signed);
      let lastError: unknown;
      for (const node of broadcasters) {
        for (let attempt = 1; ; attempt++) {
          try {
            await node.sendRawTransaction({ serializedTransaction: signed });
            return hash;
          } catch (err) {
            lastError = err;
            // A node that errors may still have taken it.
            if (await reader.getTransaction({ hash }).catch(() => null)) return hash;
            // An EIP-7702 delegated funder may have only one pending transaction; wait for the other to clear.
            if (/in-flight transaction limit/i.test(String((err as { details?: string }).details ?? err)) && attempt < 8) {
              await new Promise((res) => setTimeout(res, 3000));
              continue;
            }
            break;
          }
        }
      }
      throw lastError;
    },
    confirm: async (hash) => {
      await reader.waitForTransactionReceipt({ hash, timeout: 90_000 });
    },
  };
  g.__relayFunders.set(cacheKey, wallet);
  return wallet;
}
