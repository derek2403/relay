"use client";

import { useState } from "react";
import { usePublicClient } from "wagmi";

import { useLive } from "@/components/live/LiveContext";
import { formatError } from "@/lib/ens/errors";
import { splitFirst, tryNormalize } from "@/lib/ens/names";
import { dnsAliasEnvLine, dnsAliasRecord } from "@/lib/relay/browser";
import { RECORD_KEYS } from "@/lib/relay/bundle";
import { CHAIN_ID } from "@/lib/wagmi";

import { CopyBlock, Pill, SetupCard, Why } from "./bits";

type Lookup = { address: string | null; keys: string | null; error: string | null };

const describe = (l: Lookup) => l.error ?? `address ${l.address ?? "none"} · ${RECORD_KEYS.keys} ${l.keys || "none"}`;

/** SRC DnsAlias: x.acme.com instead of x.acme.eth, via a DNSSEC TXT record and the DNSAliasResolver. */
export function DnsAliasCard() {
  const { root, status } = useLive();
  const alias = status?.dnsAlias;
  const client = usePublicClient({ chainId: CHAIN_ID });
  const [domainInput, setDomainInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ dns: Lookup; ens: Lookup; domain: string } | null>(null);

  if (!root) {
    return (
      <SetupCard id="setupDns" index="05" title="Company domain" pill={<Pill>Waiting</Pill>}>
        <Why>Set a company name first.</Why>
      </SetupCard>
    );
  }

  const placeholder = `${splitFirst(root)[0]}.com`;
  const domain = tryNormalize(domainInput || placeholder);
  const record = domain ? dnsAliasRecord(domain, root) : null;

  const lookup = async (name: string): Promise<Lookup> => {
    try {
      const [address, keys] = await Promise.all([client!.getEnsAddress({ name }), client!.getEnsText({ name, key: RECORD_KEYS.keys })]);
      return { address: address ?? null, keys: keys ?? null, error: null };
    } catch (e) {
      return { address: null, keys: null, error: formatError(e) };
    }
  };

  const check = async () => {
    if (!domain || !client) return;
    setBusy(true);
    const [dns, ens] = await Promise.all([lookup(domain), lookup(root)]);
    setResult({ dns, ens, domain });
    setBusy(false);
  };

  const shown = result && result.domain === domain ? result : null;
  const same =
    shown && !shown.dns.error && (shown.dns.keys || shown.dns.address)
      ? shown.dns.keys === shown.ens.keys && shown.dns.address === shown.ens.address
      : false;

  return (
    <SetupCard
      id="setupDns"
      index="05"
      title="Company domain"
      pill={alias ? <Pill tone="ok">{alias.from}</Pill> : <Pill>Optional</Pill>}
      description={`Let people and agents use names like laptop.derek.${placeholder} instead of .eth names.`}
    >
      <label className="live-setup-field">
        Your domain
        <input value={domainInput} onChange={(e) => setDomainInput(e.target.value)} placeholder={placeholder} spellCheck={false} autoComplete="off" />
      </label>
      {record && domain && (
        <>
          <p className="live-setup-muted">
            1. At your DNS provider, turn on <b>DNSSEC</b> for {domain} (required), then add this TXT record on <code>{domain}</code>, and the same
            on <code>*.{domain}</code> for the names under it:
          </p>
          <CopyBlock text={record.txt} />
          <Why>
            With it, {domain} resolves as {root}, and x.{domain} as x.{root}.
          </Why>
          <p className="live-setup-muted">2. Tell the relay, in .env.local (then restart):</p>
          <CopyBlock text={dnsAliasEnvLine(domain, root)} />
          {alias && (
            <Why>
              The relay currently maps {alias.from} → {alias.to}.
            </Why>
          )}
          <div className="live-setup-actions">
            <button type="button" className="secondary" onClick={() => void check()} disabled={busy || !client}>
              {busy ? "Checking…" : `Check ${domain}`}
            </button>
            {shown && <Pill tone={same ? "ok" : "warn"}>{same ? `Resolves like ${root}` : "Not working yet"}</Pill>}
          </div>
          {shown && (
            <>
              <div className="live-setup-row">
                <span>{domain}</span>
                <b className="live-setup-mono">{describe(shown.dns)}</b>
              </div>
              <div className="live-setup-row">
                <span>{root}</span>
                <b className="live-setup-mono">{describe(shown.ens)}</b>
              </div>
            </>
          )}
          <Why>DNS changes can take a while to show up. This path hasn&apos;t been tested end to end on Sepolia.</Why>
        </>
      )}
    </SetupCard>
  );
}
