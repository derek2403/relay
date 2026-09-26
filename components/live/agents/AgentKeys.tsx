"use client";

import { useLive, type LiveNode } from "@/components/live/LiveContext";
import { Icon } from "@/components/ui/Icon";
import { cx } from "@/lib/cx";
import { useNow } from "@/lib/hooks/useNow";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useRelayPolicy } from "@/lib/hooks/useRelayApi";
import { type StoredAgentKey, roleOf } from "@/lib/relay/browser";
import { shortAddress } from "@/lib/view-model";

import { keysUnderRoot, sessionCheck, sessionLabel } from "./model";

/** Agent keys generated in this browser, with their session's time left. */
export function AgentKeys() {
  const { root } = useLive();
  const agents = useRelayAgentKeys();
  const keys = keysUnderRoot(agents.keys, root);
  const other = agents.keys.length - keys.length;

  if (!keys.length) {
    return (
      <p className="form-hint">
        No agent keys {root ? `for names under ${root} ` : ""}in this browser yet. Select a member in the tree and start an agent session.
        {other > 0 ? ` ${other} key${other === 1 ? " is" : "s are"} for another company.` : ""}
      </p>
    );
  }
  return (
    <div className="activity-list agents-keys">
      {keys.map((key) => (
        <AgentKeyRow key={key.address} agentKey={key} />
      ))}
    </div>
  );
}

const roleIcon = (name: string | undefined) => {
  const role = name ? roleOf(name) : "agent";
  return role === "user" ? "member" : role;
};

function AgentKeyRow({ agentKey }: { agentKey: StoredAgentKey }) {
  const { nodes, select, setView } = useLive();
  const now = useNow();
  const name = agentKey.name;
  const node: LiveNode | undefined = nodes.find((n) => n.name === name);
  // The tree's chain read when the name is loaded there; the relay's policy view otherwise.
  const policy = useRelayPolicy(node ? null : (name ?? null));
  const check = sessionCheck(policy.data?.levels ?? [], name, now);

  let state: "live" | "ended" | "removed" | "unknown";
  let expiry: number | null | undefined;
  if (node) {
    state = node.status === "Revoked" ? "removed" : node.status === "Expired" ? "ended" : "live";
    expiry = node.expiry === null ? null : Math.floor(node.expiry / 1000);
  } else if (check.leaf) {
    // Removed and expired names both read as not registered; "ended" covers both.
    state = check.ended ? "ended" : "live";
    expiry = check.expiry;
  } else {
    state = "unknown";
  }
  const label = sessionLabel(expiry, state, now);
  const over = state !== "live" || label === "ended";

  return (
    <div className="activity-row agents-key-row">
      <span>
        <Icon name={roleIcon(name)} />
      </span>
      <div className="agents-key-main">
        <strong className="agents-key-name">{name ?? "Unnamed key"}</strong>
        <p className="mono" title={agentKey.address}>
          {shortAddress(agentKey.address)}
        </p>
      </div>
      <span className={cx("status-pill", over && "revoked")} title={expiry ? new Date(expiry * 1000).toLocaleString() : undefined}>
        {label}
      </span>
      <button
        type="button"
        className="secondary"
        disabled={!node}
        title={node ? undefined : "Not loaded in the tree yet."}
        onClick={() => {
          if (!node) return;
          select(node.id);
          setView("tree");
        }}
      >
        Show in tree
      </button>
    </div>
  );
}
