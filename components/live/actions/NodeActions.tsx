"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { useConnection } from "wagmi";
import { MemberActions } from "@/components/live/members/MemberActions";
import { SessionActions } from "@/components/live/sessions/SessionActions";
import { type LiveNode, useLive } from "@/components/live/LiveContext";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useRelayNode } from "@/lib/hooks/useRelayNode";
import { formatDate } from "@/lib/relay/browser";
import { describeListed } from "@/lib/relay/bundle";
import { shortAddress } from "@/lib/view-model";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <b>{children}</b>
    </div>
  );
}

/**
 * The detail panel's live actions for the selected name (SRC NameActions): read-only
 * facts, then what the connected wallet can do, from the members and sessions features.
 */
export function NodeActions({ node }: { node: LiveNode }) {
  const { address, onSepolia } = useLive();
  const { isConnected } = useConnection();
  const chain = useRelayNode({ name: node.name, registry: node.registry });
  const agents = useRelayAgentKeys();

  // The tree's listings are polled; when they show this name changed on-chain (the CLI enabled
  // names below it, it was removed or extended), re-read the panel's own chain state too.
  const seen = `${node.status}|${node.subregistry ?? ""}|${node.expiry ?? ""}|${node.owner}`;
  const lastSeen = useRef(seen);
  const { refetch } = chain;
  useEffect(() => {
    if (lastSeen.current === seen) return;
    lastSeen.current = seen;
    void refetch();
  }, [seen, refetch]);

  const owner = chain.owner ?? chain.state?.latestOwner ?? null;
  const agentKey = node.kind === "agent" ? agents.find(owner) : undefined;
  const mayUse = chain.bundleLoading
    ? "…"
    : chain.bundleError
      ? "Couldn't read. Refresh to try again."
      : chain.bundle?.plan
        ? `${describeListed(chain.bundle.bundle)} (plan ${chain.bundle.plan})`
        : describeListed(chain.bundle?.bundle ?? node.bundle);

  return (
    <div className="live-node-actions">
      <div className="detail-section">
        <Fact label="Owner">
          <a href={`https://sepolia.etherscan.io/address/${owner ?? node.owner}`} target="_blank" rel="noreferrer" title={owner ?? node.owner}>
            {shortAddress(owner ?? node.owner)}
          </a>
          {chain.iOwn && <span className="live-badge">you</span>}
          {agentKey && <span className="live-badge">key in this browser</span>}
        </Fact>
        <Fact label="May use">{mayUse}</Fact>
        <Fact label="Expires">{chain.expiry ? formatDate(chain.expiry) : "—"}</Fact>
        <Fact label="Names below">{chain.subregistry ? "Enabled" : "Not enabled"}</Fact>
      </div>
      {node.aliasOf ? (
        // Writes here would land in another group's registry under a path the relay refuses.
        <p className="form-hint">
          {node.name} is an alias of {node.aliasOf}. Add people and agents under {node.aliasOf} instead.
        </p>
      ) : (
        <>
          {!isConnected || !address ? (
            <p className="form-hint">Connect a wallet to act on {node.name}.</p>
          ) : !onSepolia ? (
            <p className="form-hint">Switch your wallet to Sepolia to act on {node.name}.</p>
          ) : null}
          <MemberActions node={node} />
          <SessionActions node={node} />
        </>
      )}
    </div>
  );
}
