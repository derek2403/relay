"use client";

import { useLive } from "@/components/live/LiveContext";
import { explorerAddress } from "@/lib/ens/contracts";
import { funderOf } from "@/lib/relay/browser";

import { Pill, SetupCard, Why } from "./bits";
import { funderSummary } from "./setup-model";

/** The relay's gas funder (lib/relay/fund.ts, POST /api/fund), as far as GET /api/relay/status reveals it. */
export function FunderCard() {
  const { status } = useLive();
  const funder = funderOf(status);
  const summary = funderSummary(funder);

  return (
    <SetupCard
      id="setupFunder"
      index="02"
      title="Gas for new members"
      pill={<Pill tone={summary.on ? "ok" : "warn"}>{summary.on ? "On" : "Off"}</Pill>}
      description="The relay can top up a new member's wallet with a little Sepolia ETH, so they can create their own agents without anyone sending gas by hand."
    >
      <div className={summary.on ? "live-setup-muted" : "form-hint"}>{summary.text}</div>
      {funder?.address && (
        <div className="live-setup-row">
          <span>Funder wallet</span>
          <a className="live-setup-mono" href={explorerAddress(funder.address)} target="_blank" rel="noreferrer">
            {funder.address}
          </a>
        </div>
      )}
      <ul className="live-setup-ticks">
        <li>Only members get gas: names under the company, held by someone other than the company owner. Agents never do.</li>
        <li>Only wallets low on Sepolia ETH, once per registration.</li>
        <li>A daily limit caps the total per UTC day. No sign-in: the chain is the check.</li>
      </ul>
      {!summary.on && <Why>Set FUNDER_PRIVATE_KEY (a small hot wallet with Sepolia ETH) and FUNDER_AMOUNT_ETH on the relay to turn this on.</Why>}
    </SetupCard>
  );
}
