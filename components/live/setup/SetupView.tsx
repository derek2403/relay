"use client";

// Live Setup view (nav "05 Setup"): relay status, company setup checklist, Session Minter, DNS alias,
// scripts and the gas funder. Contract: components/live/LiveContext.tsx.

import { CompanySetupCard } from "./CompanySetupCard";
import { DnsAliasCard } from "./DnsAliasCard";
import { FunderCard } from "./FunderCard";
import { RelayStatusCard } from "./RelayStatusCard";
import { ScriptsCard } from "./ScriptsCard";
import { SessionMinterCard } from "./SessionMinterCard";

export function SetupView() {
  return (
    <div className="live-setup" id="liveSetup">
      <div className="live-setup-grid">
        <RelayStatusCard />
        <FunderCard />
      </div>
      <CompanySetupCard />
      <div className="live-setup-grid">
        <SessionMinterCard />
        <DnsAliasCard />
      </div>
      <ScriptsCard />
    </div>
  );
}
