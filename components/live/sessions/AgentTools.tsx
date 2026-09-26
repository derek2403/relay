"use client";

// For an agent whose key lives in this browser: access token + snippets, primary name, forget key.
// SRC app/_components/AgentTools.tsx in khaki.

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { createWalletClient, formatEther, http, isAddressEqual, parseAbi, parseEther } from "viem";
import { sepolia } from "viem/chains";
import { useBalance, useEnsAddress, useEnsName, usePublicClient, useReadContract, useSendTransaction } from "wagmi";

import { ReverseRegistrarAdapterAbi } from "@/lib/ens/abis/ReverseRegistrarAdapter";
import { addresses } from "@/lib/ens/contracts";
import { formatError } from "@/lib/ens/errors";
import { useNow } from "@/lib/hooks/useNow";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useTx } from "@/lib/hooks/useTx";
import { type StoredAgentKey, agentAccount, agentToken, formatDate, nowSec, tokenSnippets } from "@/lib/relay/browser";
import { DEFAULT_MAX_TOKEN_TTL_SEC, parseToken } from "@/lib/relay/token";
import { shortAddress } from "@/lib/view-model";
import { CHAIN_ID, RPC_URL } from "@/lib/wagmi";

import { useLive } from "../LiveContext";
import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";
import { txBusyLabel } from "../tx/txView";
import { formatTtl, tokenExpiry, topUpAmount } from "./logic";
import { Snippet } from "./Snippet";

// Primary names stay on ENSv1 at launch: the agent key calls setName on the
// v1 ReverseRegistrar that the v2 ReverseRegistrarAdapter points to.
const reverseRegistrarAbi = parseAbi(["function setName(string name) returns (bytes32)"]);

type AgentInfo = { name: string; expiry: number | null; active: boolean };

/** Rendered with key={expiry}, so "Extend" drops a token made for the old end time. */
export function AgentTools({ agent, agentKey, onForgot }: { agent: AgentInfo; agentKey: StoredAgentKey; onForgot: () => void }) {
  const live = useLive();
  const agents = useRelayAgentKeys();
  const now = useNow();
  const [token, setToken] = useState<{ value: string; exp: number; baseUrl: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const clock = now || nowSec();
  const ended = !agent.active || !agent.expiry || agent.expiry <= clock;
  const maxTtl = live.status?.maxTokenTtlSec ?? DEFAULT_MAX_TOKEN_TTL_SEC;
  const tokenExpired = !!token && token.exp <= clock;

  const makeToken = async () => {
    setTokenError(null);
    try {
      const value = await agentToken(agentKey, agent.name, agent.expiry!, maxTtl);
      // Read in the click handler, never during render (hydration).
      const baseUrl = live.status?.baseUrl ?? `${window.location.origin}/api/relay`;
      setToken({ value, exp: parseToken(value).payload.exp, baseUrl });
      live.log("Access token made", `${agent.name} · valid until ${formatDate(parseToken(value).payload.exp)}`);
    } catch (e) {
      setTokenError(formatError(e));
    }
  };

  const forget = () => {
    agents.remove(agentKey.address);
    live.log("Agent key forgotten", `${agent.name} · ${shortAddress(agentKey.address)}`);
    live.toast("Agent key deleted from this browser.");
    onForgot();
  };

  return (
    <>
      <section className="live-tools-section">
        <h3>Access token</h3>
        <p className="dialog-description">
          Use it wherever a tool asks for an API key. It is signed by the agent key, stops working when {agent.name} ends
          {agent.expiry ? ` (${formatDate(agent.expiry)})` : ""} or is removed, lasts at most {formatTtl(maxTtl)}, and never contains a provider key.
        </p>
        {!token || ended || tokenExpired ? (
          <>
            {!ended && agent.expiry && now > 0 && <p className="form-hint">A new token is valid until {formatDate(tokenExpiry(agent.expiry, now, maxTtl))}.</p>}
            <button type="button" className="detail-button" onClick={() => void makeToken()} disabled={ended}>
              {tokenExpired && !ended ? "Show a new access token" : "Show access token"}
            </button>
          </>
        ) : (
          <>
            <Snippet label={`Access token · valid until ${formatDate(token.exp)}`} text={token.value} />
            {tokenSnippets(token.baseUrl, token.value).map((s) => (
              <Snippet key={s.label} label={s.label} text={s.text} />
            ))}
          </>
        )}
        {ended && <p className="form-hint">This session has ended; extend it to get a new token.</p>}
        <p className="form-error" role="alert">
          {tokenError}
        </p>
      </section>

      <PrimaryName name={agent.name} agentKey={agentKey} />

      <section className="live-tools-section">
        <h3>Key in this browser</h3>
        <p className="dialog-description">
          The agent&apos;s private key is stored unencrypted in this browser, for testing only. Real agents should keep their own key (npm run agent -- new).
        </p>
        {!confirmForget ? (
          <button type="button" className="secondary" onClick={() => setConfirmForget(true)}>
            Forget key
          </button>
        ) : (
          <div className="live-tools-confirm" role="alertdialog" aria-label="Delete the agent key from this browser?">
            <b>Delete the agent key from this browser?</b>
            <p>
              Nobody can make new tokens for {agent.name} after this; tokens already copied keep working until they expire. To cut it off now, remove{" "}
              {agent.name} as well.
            </p>
            <div className="live-tools-buttons">
              <button type="button" className="danger" onClick={forget}>
                Yes, forget it
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmForget(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function PrimaryName({ name, agentKey }: { name: string; agentKey: StoredAgentKey }) {
  const live = useLive();
  const client = usePublicClient({ chainId: CHAIN_ID });
  const { mutateAsync: send } = useSendTransaction();
  const fundTx = useTx();
  const nameTx = useTx();
  const agent = agentKey.address;

  const reverseRegistrar = useReadContract({
    address: addresses.ReverseRegistrarAdapter,
    abi: ReverseRegistrarAdapterAbi,
    functionName: "REVERSE_REGISTRAR",
    chainId: CHAIN_ID,
  });
  const forward = useEnsAddress({ name, chainId: CHAIN_ID });
  const current = useEnsName({ address: agent, chainId: CHAIN_ID });
  const balance = useBalance({ address: agent, chainId: CHAIN_ID });
  const pointsBack = !!forward.data && isAddressEqual(forward.data, agent);

  // What setName costs the agent key right now, with headroom for fee changes.
  const needed = useQuery({
    queryKey: ["agent-gas", agent, name, reverseRegistrar.data],
    enabled: !!client && !!reverseRegistrar.data,
    queryFn: async () => {
      const [gas, fees] = await Promise.all([
        client!
          .estimateContractGas({ account: agent, address: reverseRegistrar.data!, abi: reverseRegistrarAbi, functionName: "setName", args: [name] })
          .catch(() => 150_000n),
        client!.estimateFeesPerGas(),
      ]);
      return ((gas * 13n) / 10n) * fees.maxFeePerGas;
    },
  });
  const need = needed.data ?? parseEther("0.001");
  const funded = balance.data !== undefined && balance.data.value >= need;
  // Send double what's missing, at least 0.0005 ETH, so a retry doesn't need another top-up.
  const topUp = topUpAmount(need, balance.data?.value ?? 0n, parseEther("0.0005"));

  const fund = async () => {
    const r = await fundTx.run(() => send({ to: agent, value: topUp, chainId: CHAIN_ID }));
    if (!r) return;
    await balance.refetch();
    live.log("Agent funded", `${formatEther(topUp)} ETH to ${shortAddress(agent)}`);
    live.toast("Sent. The agent has gas money.");
  };

  const setPrimary = async () => {
    if (!reverseRegistrar.data) return;
    const wallet = createWalletClient({ account: agentAccount(agentKey), chain: sepolia, transport: http(RPC_URL) });
    const r = await nameTx.run(() => wallet.writeContract({ address: reverseRegistrar.data!, abi: reverseRegistrarAbi, functionName: "setName", args: [name] }));
    if (!r) return;
    await Promise.all([current.refetch(), balance.refetch()]);
    await live.refresh();
    live.log("Primary name set", `${shortAddress(agent)} → ${name}`);
    live.toast("Primary name saved on Sepolia.");
  };

  return (
    <section className="live-tools-section">
      <h3>Primary name</h3>
      <p className="dialog-description">
        So apps and explorers show {name} for the agent&apos;s address (<b title={agent}>{shortAddress(agent)}</b>). The agent key sends this transaction
        itself, so it needs a little Sepolia ETH first.
      </p>
      <p className="live-tools-facts">
        Shown now: <b>{current.isLoading ? "…" : (current.data ?? "none")}</b>
        {" · "}Agent balance: <b>{balance.data ? `${Number(formatEther(balance.data.value)).toFixed(5)} ETH` : "…"}</b>
      </p>
      {forward.data !== undefined && !pointsBack && (
        <p className="form-hint">
          {name} doesn&apos;t resolve to the agent key yet, so the primary name won&apos;t show. Its address record is written when the session starts.
        </p>
      )}
      <div className="live-tools-buttons">
        <TxButton tx={fundTx} variant="secondary" onClick={() => void fund()} disabled={funded || needed.isLoading}>
          {funded ? "Agent has gas money" : `1. Send ${Number(formatEther(topUp)).toFixed(4)} ETH to the agent`}
        </TxButton>
        {/* The agent key signs this one itself, so it doesn't need the connected wallet or its chain. */}
        <button
          type="button"
          className="primary tx-button"
          aria-busy={nameTx.busy || undefined}
          disabled={nameTx.busy || !funded || !reverseRegistrar.data || current.data === name}
          onClick={() => void setPrimary()}
        >
          {txBusyLabel(nameTx.state.status) ?? (current.data === name ? "Primary name set" : `2. Set ${name} as its primary name`)}
        </button>
      </div>
      <TxStatus tx={fundTx} />
      <TxStatus tx={nameTx} />
    </section>
  );
}
