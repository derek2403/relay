"use client";

import { useState } from "react";
import { type Address, type Hex, bytesToHex, erc20Abi, formatUnits, parseAbi, parseUnits, zeroAddress, zeroHash } from "viem";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";

import { useLive } from "@/components/live/LiveContext";
import { type Step, Steps } from "@/components/live/tx/Steps";
import { TxButton } from "@/components/live/tx/TxButton";
import { TxStatus } from "@/components/live/tx/TxStatus";
import { ETHRegistrarAbi } from "@/lib/ens/abis/ETHRegistrar";
import { PAYMENT_TOKENS, addresses } from "@/lib/ens/contracts";
import { useLocalJson } from "@/lib/hooks/useLocalJson";
import { useMyResolver } from "@/lib/hooks/useMyResolver";
import { useNow } from "@/lib/hooks/useNow";
import { useTx } from "@/lib/hooks/useTx";
import { useWorkspace } from "@/lib/hooks/useWorkspace";
import { CHAIN_ID } from "@/lib/wagmi";

import { Why, useOnTxSuccess } from "./bits";
import { REGISTER_STEPS, YEAR, approveAmount, commitStorageKey, commitWaitLeft, needsApproval, registerLabel, registerStep } from "./setup-model";

const USDC = PAYMENT_TOKENS.MockUSDC;
const REGISTRAR = addresses.ETHRegistrar;
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

type Pending = { secret: Hex; duration: string; resolver: Address };

/** SRC RegisterRoot: the test-USDC faucet, then the commit-reveal registration of a .eth name. */
export function RegisterRoot({ onRegistered }: { onRegistered: (name: string) => void }) {
  return (
    <div className="live-setup-register">
      <Faucet />
      <RegisterName onRegistered={onRegistered} />
    </div>
  );
}

/** SRC Faucet: balance + permissionless mint of Sepolia MockUSDC. */
function Faucet({ amount = "100" }: { amount?: string }) {
  const { address, log, toast } = useLive();
  const { mutateAsync } = useWriteContract();
  const tx = useTx();
  const balance = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });

  const mint = async () => {
    if (!address) return;
    const r = await tx.run(() =>
      mutateAsync({ address: USDC.address, abi: mintAbi, functionName: "mint", args: [address, parseUnits(amount, USDC.decimals)], chainId: CHAIN_ID }),
    );
    if (r) {
      void balance.refetch();
      log("USDC minted", `${amount} ${USDC.symbol} to ${address}`);
      toast(`${amount} USDC minted.`);
    }
  };

  return (
    <section className="live-setup-sub">
      <h3>1. Get Sepolia USDC</h3>
      <p className="live-setup-muted">Registering a .eth name on Sepolia costs a small USDC fee. Mint some here first.</p>
      <div className="live-setup-row">
        <span>Balance</span>
        <b className="live-setup-mono">{balance.data === undefined ? "—" : `${formatUnits(balance.data, USDC.decimals)} ${USDC.symbol}`}</b>
      </div>
      <div className="live-setup-actions">
        <TxButton tx={tx} variant="secondary" onClick={() => void mint()}>
          Mint {amount} {USDC.symbol}
        </TxButton>
      </div>
      <TxStatus tx={tx} />
    </section>
  );
}

/** SRC RegisterCard: resolver, approve, commit, wait a minute, register. The secret is kept in this browser. */
function RegisterName({ onRegistered }: { onRegistered: (name: string) => void }) {
  const { address, refresh, log, toast } = useLive();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync } = useWriteContract();
  const { add } = useWorkspace();
  const my = useMyResolver();
  const tx = useTx();
  const now = useNow();

  const [input, setInput] = useState("");
  const [years, setYears] = useState("1");
  const label = registerLabel(input);

  const [pending, setPending] = useLocalJson<Pending | null>(label && address ? commitStorageKey(address, label) : null, null);
  const duration = pending ? BigInt(pending.duration) : BigInt(years) * YEAR;
  const resolver = pending?.resolver ?? my.resolver;

  const available = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "isAvailable",
    args: label ? [label] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!label },
  });
  const price = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "getRegisterPrice",
    args: label ? [label, duration, USDC.address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!label && available.data === true },
  });
  const total = price.data ? price.data[0] + price.data[1] : undefined;

  const allowance = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, REGISTRAR] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });
  const balance = useReadContract({
    address: USDC.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });

  const commitment = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "makeCommitment",
    args: label && address && pending ? [label, address, pending.secret, zeroAddress, pending.resolver, duration, zeroHash] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!label && !!address && !!pending },
  });
  const committedAt = useReadContract({
    address: REGISTRAR,
    abi: ETHRegistrarAbi,
    functionName: "commitmentAt",
    args: commitment.data ? [commitment.data] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!commitment.data },
  });
  const commitTime = committedAt.data ? Number(committedAt.data) : 0;
  const waitLeft = commitWaitLeft(commitTime, now);

  const approval = needsApproval(total, allowance.data);
  const lowBalance = total !== undefined && balance.data !== undefined && balance.data < total;

  useOnTxSuccess(my.tx, () => {
    log("Resolver deployed", `${my.resolver ?? ""} holds your limits`);
    toast("Resolver deployed on Sepolia.");
    void refresh();
  });

  const approve = async () => {
    if (total === undefined) return;
    const r = await tx.run(() =>
      mutateAsync({ address: USDC.address, abi: erc20Abi, functionName: "approve", args: [REGISTRAR, approveAmount(total)], chainId: CHAIN_ID }),
    );
    if (r) {
      void allowance.refetch();
      toast("USDC approved.");
    }
  };

  const commit = async () => {
    if (!label || !address || !client || !resolver) return;
    let p = pending;
    if (!p) {
      p = { secret: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), duration: duration.toString(), resolver };
      setPending(p);
    }
    const c = await client.readContract({
      address: REGISTRAR,
      abi: ETHRegistrarAbi,
      functionName: "makeCommitment",
      args: [label, address, p.secret, zeroAddress, p.resolver, BigInt(p.duration), zeroHash],
    });
    const r = await tx.run(() => mutateAsync({ address: REGISTRAR, abi: ETHRegistrarAbi, functionName: "commit", args: [c], chainId: CHAIN_ID }));
    if (r) {
      await commitment.refetch();
      void committedAt.refetch();
      log("Commitment sent", `${label}.eth · register in about a minute`);
      toast("Committed. Wait about a minute.");
    }
  };

  const register = async () => {
    if (!label || !address || !pending) return;
    const r = await tx.run(() =>
      mutateAsync({
        address: REGISTRAR,
        abi: ETHRegistrarAbi,
        functionName: "register",
        args: [label, address, pending.secret, zeroAddress, pending.resolver, duration, USDC.address, zeroHash],
        chainId: CHAIN_ID,
      }),
    );
    if (r) {
      const name = `${label}.eth`;
      setPending(null);
      add("names", name);
      void available.refetch();
      void balance.refetch();
      onRegistered(name);
      await refresh();
      log("Name registered", `${name} is yours for ${duration / YEAR} year${duration === YEAR ? "" : "s"}`);
      toast(`${name} registered on Sepolia.`);
    }
  };

  const step = registerStep({ resolverDeployed: my.deployed, needsApproval: approval, commitTime, waitLeft });
  const actions = [
    <TxButton key="0" tx={my.tx} onClick={() => void my.deploy()}>
      Deploy my resolver
    </TxButton>,
    <TxButton key="1" tx={tx} onClick={() => void approve()} disabled={lowBalance}>
      Approve {total !== undefined ? formatUnits(approveAmount(total), USDC.decimals) : ""} USDC
    </TxButton>,
    <TxButton key="2" tx={tx} onClick={() => void commit()}>
      Commit
    </TxButton>,
    <span key="3" className="live-setup-countdown">
      {waitLeft === null ? "…" : `${waitLeft}s`}
    </span>,
    <TxButton key="4" tx={tx} variant="primary" onClick={() => void register()} disabled={lowBalance}>
      Register {label}.eth
    </TxButton>,
  ];
  const steps: Step[] = REGISTER_STEPS.map((title, i) => ({
    label: title,
    done: step > i,
    active: step === i,
    detail: step === i ? <div className="live-setup-actions">{actions[i]}</div> : undefined,
  }));

  return (
    <section className="live-setup-sub">
      <h3>2. Register a .eth name</h3>
      <p className="live-setup-muted">
        Commit to a secret, wait a minute so nobody can front-run you, then register. Fees are paid in Sepolia USDC.
      </p>
      <div className="form-row">
        <label>
          Name
          <span className="live-setup-suffix">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="yourcompany" spellCheck={false} autoComplete="off" />
            <b>.eth</b>
          </span>
        </label>
        <label>
          Duration
          <select value={pending ? String(duration / YEAR) : years} onChange={(e) => setYears(e.target.value)} disabled={!!pending}>
            {["1", "2", "3", "5"].map((y) => (
              <option key={y} value={y}>
                {y} year{y === "1" ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {label && (available.data !== undefined || total !== undefined) && (
        <div className="live-setup-row">
          <span>{available.data === undefined ? "" : available.data ? "Available" : "Taken"}</span>
          <b className="live-setup-mono">{total !== undefined ? `${formatUnits(total, USDC.decimals)} USDC` : ""}</b>
        </div>
      )}
      {input && !label && <p className="form-error">Enter a single label, e.g. &quot;yourcompany&quot;.</p>}
      {price.error && <p className="form-error">Can&apos;t price this name (it may be too short or not available).</p>}
      {lowBalance && <p className="form-error">Not enough USDC. Mint some in step 1.</p>}
      {!address && <Why>Connect a wallet to register.</Why>}

      {label && available.data && address && <Steps steps={steps} />}
      {pending && (
        <button type="button" className="parent-link" onClick={() => setPending(null)}>
          Start over (discard the saved commitment for {label}.eth)
        </button>
      )}
      <TxStatus tx={tx} />
      <TxStatus tx={my.tx} />
    </section>
  );
}
