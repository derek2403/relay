"use client";

// Live "03 Agents": agent keys in this browser, try a call, live spend and the relay's log.
// Contract: see components/live/LiveContext.tsx.

import { SectionHeading } from "@/components/shell/SectionHeading";
import { useLiveLog } from "@/lib/live/hooks";

import { useLive } from "../LiveContext";

import { AgentKeys } from "./AgentKeys";
import { LiveSpend } from "./LiveSpend";
import { RelayActivityLog } from "./RelayLog";
import { TryCall } from "./TryCall";

export function AgentsView() {
  // One 5 s poll feeds both "Try a call" (its cost line) and the activity table.
  const { status } = useLive();
  const log = useLiveLog(20, 5_000, !!status && status.viewAuth !== "closed");
  return (
    <div className="agents-view">
      <section className="agents-section">
        <SectionHeading title="Agent keys" subtitle="Keys made in this browser, with the time left on each session." />
        <AgentKeys />
      </section>

      <section className="agents-section">
        <SectionHeading title="Try a call" subtitle="A request through the relay, signed by one of these agents." />
        <TryCall log={log} />
      </section>

      <section className="agents-section">
        <SectionHeading title="Live spend" subtitle="A user, its agents and subagents. Updated every 3 seconds." />
        <LiveSpend />
      </section>

      <section className="agents-section">
        <SectionHeading title="Relay activity" subtitle="The relay's latest decisions. Updated every 5 seconds." />
        <RelayActivityLog entries={log.data} error={log.error} />
      </section>
    </div>
  );
}
