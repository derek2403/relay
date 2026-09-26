// Registering the company's <org>.eth through the ETHRegistrar, shared by org-setup and org-seed
// (moved here from scripts/org-setup.ts unchanged, with the output passed in).
//
// Relative imports only (like ensv2.ts).

import { type Address, type Hex, concat, encodeFunctionData, keccak256, stringToHex, zeroHash } from "viem";

import { ETHRegistrarAbi } from "../../lib/ens/abis/ETHRegistrar";
import { MockUSDCAbi } from "../../lib/ens/abis/MockUSDC";
import { type Chain, ETH_REGISTRAR, type Log, MOCK_USDC, type Sender, chainNow } from "./ensv2";

const DAY = 86_400;

async function rpc<T>(chain: Chain, method: string, params: unknown[]): Promise<T> {
  return (await chain.pub.request({ method, params } as never)) as T;
}

/**
 * Registers <org>.eth through the ETHRegistrar: MockUSDC (free to mint), commit, wait, register.
 * On a local fork the commitment wait is skipped with evm_increaseTime. `out.check` prints a
 * finished step, `out.say` any other line. `days` is the term (at least the registrar's minimum).
 */
export async function registerRoot(
  chain: Chain,
  sender: Sender,
  privateKey: Hex,
  label: string,
  subregistry: Address,
  resolver: Address,
  out: { check: Log; say: Log },
  days = 365,
) {
  const { pub } = chain;
  const { check, say } = out;
  const admin = sender.address;
  const read = <T>(functionName: string, args: unknown[] = []) =>
    pub.readContract({ address: ETH_REGISTRAR, abi: ETHRegistrarAbi, functionName, args } as never) as Promise<T>;

  const minDuration = Number(await read<bigint>("MIN_REGISTER_DURATION"));
  const duration = BigInt(Math.max(days * DAY, minDuration));
  const [base, premium] = await read<[bigint, bigint]>("getRegisterPrice", [label, duration, MOCK_USDC]);
  const price = base + premium;
  const [balance, allowance] = await Promise.all([
    pub.readContract({ address: MOCK_USDC, abi: MockUSDCAbi, functionName: "balanceOf", args: [admin] }),
    pub.readContract({ address: MOCK_USDC, abi: MockUSDCAbi, functionName: "allowance", args: [admin, ETH_REGISTRAR] }),
  ]);
  const pay: { title: string; call: { to: Address; data: Hex } }[] = [];
  if (balance < price) {
    pay.push({ title: `mint ${Number(price) / 1e6} MockUSDC`, call: { to: MOCK_USDC, data: encodeFunctionData({ abi: MockUSDCAbi, functionName: "mint", args: [admin, price - balance] }) } });
  }
  if (allowance < price) {
    pay.push({ title: "approve the ETHRegistrar to take it", call: { to: MOCK_USDC, data: encodeFunctionData({ abi: MockUSDCAbi, functionName: "approve", args: [ETH_REGISTRAR, price] }) } });
  }
  await sender.sendAll(pay);

  // The secret comes from the admin key, so it is unguessable and the same on a re-run (resume after the commit).
  const secret = keccak256(concat([privateKey, stringToHex(`keyless-relay:org:${label}`)]));
  const commitArgs = [label, admin, secret, subregistry, resolver, duration, zeroHash] as const;
  const commitment = await read<Hex>("makeCommitment", [...commitArgs]);
  const [minAge, maxAge] = (await Promise.all([read<bigint>("MIN_COMMITMENT_AGE"), read<bigint>("MAX_COMMITMENT_AGE")])).map(Number);
  let at = Number(await read<bigint>("commitmentAt", [commitment]));
  if (!at || (await chainNow(pub)) > at + maxAge) {
    const [receipt] = await sender.sendAll([
      { title: `commit to ${label}.eth`, call: { to: ETH_REGISTRAR, data: encodeFunctionData({ abi: ETHRegistrarAbi, functionName: "commit", args: [commitment] }) } },
    ]);
    at = Number((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
  } else {
    check(`commit to ${label}.eth (already done)`);
  }

  const ready = at + minAge + 1;
  const latest = async () => Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
  let now = await latest();
  if (now < ready && chain.local) {
    await rpc(chain, "evm_increaseTime", [ready - now]);
    await rpc(chain, "evm_mine", []);
    check(`skipped the ${minAge} s commitment wait (local fork: evm_increaseTime)`);
  } else if (now < ready) {
    say(`  … waiting ${ready - now} s before registering (the registrar makes commitments age ${minAge} s)`);
    while (now < ready) {
      await new Promise((r) => setTimeout(r, 4000));
      now = await latest();
    }
  }
  const registerCall = {
    to: ETH_REGISTRAR,
    data: encodeFunctionData({ abi: ETHRegistrarAbi, functionName: "register", args: [label, admin, secret, subregistry, resolver, duration, MOCK_USDC, zeroHash] }),
  };
  // A load-balanced RPC may still estimate against an older block right after the wait.
  for (let attempt = 0; ; attempt++) {
    try {
      await sender.sendAll([{ title: `register ${label}.eth for ${Number(duration) / DAY} days`, call: registerCall }]);
      return;
    } catch (err) {
      if (attempt >= 4 || !/CommitmentTooNew/.test(String((err as Error).message))) throw err;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
