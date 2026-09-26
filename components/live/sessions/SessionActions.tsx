"use client";

// Live session tools for the selected node (SRC NameActions: StartSession, AgentTools, own-key agent
// tokens; plus "Create a subagent", new in live mode). Rendered in the detail panel.

import { useState } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { useNow } from "@/lib/hooks/useNow";
import { useRelayAgentKeys } from "@/lib/hooks/useRelayAgents";
import { useRelayNode } from "@/lib/hooks/useRelayNode";
import { AGENT_CLI, isNever, relayTokenCommand } from "@/lib/relay/browser";

import { type LiveNode, useLive } from "../LiveContext";
import { AgentTools } from "./AgentTools";
import { countdown } from "./logic";
import { SessionForm } from "./SessionForm";
import { Snippet } from "./Snippet";
import { SubagentForm } from "./SubagentForm";

type DialogKind = "session" | "subagent" | "tools" | "setup";

export function SessionActions({ node }: { node: LiveNode }) {
  const live = useLive();
  const rn = useRelayNode({ name: node.name, registry: node.registry });
  const agents = useRelayAgentKeys();
  const now = useNow();
  const [open, setOpen] = useState<DialogKind | null>(null);
  const close = () => setOpen(null);
  const done = (name: string) => {
    close();
    live.select(name);
  };

  const isAgent = node.kind === "agent";
  const active = rn.active;
  const canAdd = !isAgent && rn.iOwn && !!rn.subregistry && rn.canAddBelow;
  const agentKey = isAgent ? agents.find(rn.owner ?? rn.state?.latestOwner) : undefined;
  const ownKeyAgent = isAgent && !agentKey && active;
  // Subagents don't get subagents of their own (the relay CLI tells them not to create any).
  const mayHaveSubagents = isAgent && node.type !== "subagent";
  const ends = isAgent && rn.expiry && !isNever(rn.expiry) ? countdown(rn.expiry, now) : null;

  return (
    <div className="live-session-actions">
      {ends && (
        <p className={`live-session-countdown${ends === "Ended" ? " is-ended" : ""}`} aria-live="off">
          {ends}
        </p>
      )}
      {canAdd && (
        <button type="button" className="detail-button" disabled={!active} onClick={() => setOpen("session")}>
          Start an agent session
        </button>
      )}
      {mayHaveSubagents && (
        <button type="button" className="detail-button" disabled={!active} onClick={() => setOpen("subagent")}>
          Create a subagent
        </button>
      )}
      {agentKey && (
        <button type="button" className="detail-button" onClick={() => setOpen("tools")}>
          Show access token
        </button>
      )}
      {ownKeyAgent && (
        <button type="button" className="detail-button" onClick={() => setOpen("setup")}>
          Agent setup
        </button>
      )}

      <Dialog id="liveSessionDialog" open={open === "session"} onClose={close}>
        {open === "session" && rn.subregistry && (
          <form className="live-session-form" onSubmit={(e) => e.preventDefault()}>
            <Heading title="Start a session" onClose={close} />
            <p className="dialog-description">
              An agent session is a name under {node.name} owned by the agent&apos;s key, with no roles and an end time. When it ends or is removed, the agent is
              cut off.
            </p>
            <SessionForm
              kind="session"
              parentName={node.name}
              parentBundle={node.bundle}
              registry={rn.subregistry}
              registryLive
              onDone={done}
              onCancel={close}
            />
          </form>
        )}
      </Dialog>

      <Dialog id="liveSubagentDialog" open={open === "subagent"} onClose={close}>
        {open === "subagent" && (
          <form className="live-session-form" onSubmit={(e) => e.preventDefault()}>
            <Heading title="Create a subagent" onClose={close} />
            <p className="dialog-description">
              A subagent gets its own name under {node.name}, its own key and a smaller budget. It can never outlive or outspend its agent.
            </p>
            <SubagentForm
              agent={{
                name: node.name,
                registry: node.registry,
                subregistry: rn.subregistry,
                bundle: node.bundle,
                expiry: rn.expiry,
                active,
                canAddBelow: rn.canAddBelow,
              }}
              onDone={done}
              onCancel={close}
            />
          </form>
        )}
      </Dialog>

      <Dialog id="liveAgentToolsDialog" open={open === "tools"} onClose={close}>
        {open === "tools" && agentKey && (
          <div className="live-session-form">
            <Heading title="Agent tools" onClose={close} />
            <AgentTools key={rn.expiry ?? 0} agent={{ name: node.name, expiry: rn.expiry, active }} agentKey={agentKey} onForgot={close} />
            <div className="dialog-footer">
              <button type="button" className="secondary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog id="liveAgentSetupDialog" open={open === "setup"} onClose={close}>
        {open === "setup" && (
          <div className="live-session-form">
            <Heading title="Agent setup" onClose={close} />
            <p className="dialog-description">
              This agent keeps its own key, so it signs its own tokens. Nothing secret leaves its machine. Run one of these there.
            </p>
            <Snippet label="Made with ./relay on the user's laptop: print a token" text={relayTokenCommand(node.name)} />
            <Snippet label="Key made with npm run agent -- new: point Claude Code and Codex at the relay" text={AGENT_CLI.env(node.name, live.status?.baseUrl)} />
            <div className="dialog-footer">
              <button type="button" className="secondary" onClick={close}>
                Done
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function Heading({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="dialog-heading">
      <h2>{title}</h2>
      <button type="button" className="icon-button close-dialog" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
