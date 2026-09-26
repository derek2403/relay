"use client";

// "Your approver identity": the connected wallet, and whether a World ID is linked to it
// (enrollment: challenge → wallet signature → Selfie Check → confirm).

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useQuery } from "@tanstack/react-query";

import { useLive } from "@/components/live/LiveContext";
import { statusOf } from "@/components/live/providers/api";
import { errorText } from "@/lib/relay/browser";
import { shortAddress } from "@/lib/view-model";

import { approvalsApi } from "./api";
import { FlowSteps } from "./FlowSteps";
import { useSignedFlow } from "./useSignedFlow";

export function IdentityCard() {
  const live = useLive();
  const { openConnectModal } = useConnectModal();
  const address = live.address;
  const approver = useQuery({
    queryKey: ["relay-approver", address],
    queryFn: () => approvalsApi.approver(address!),
    enabled: !!address,
    retry: false,
    staleTime: 30_000,
  });
  const flow = useSignedFlow({
    issue: () => approvalsApi.enrollChallenge(address!),
    confirm: (c, signature, world) => approvalsApi.enrollConfirm({ challengeId: c.id, signature, world }),
    onDone: () => {
      void approver.refetch();
      live.toast("World ID linked to this approver.");
      live.log("World ID linked", address ?? "");
    },
  });
  const world = live.status?.world;
  const busy = flow.phase !== "idle" && flow.phase !== "done" && flow.phase !== "failed";

  return (
    <article className="provider-card appr-identity">
      <div className="appr-identity-head">
        <h3>Your approver identity</h3>
        {world && <span className={`status-pill appr-env env-${world.environment}`}>{world.configured ? `World · ${world.environment}` : "World not set up"}</span>}
      </div>
      {!address ? (
        <>
          <p>Connect the wallet that owns your place in the tree. Approvals are signed with it.</p>
          <button type="button" className="primary" onClick={() => openConnectModal?.()}>
            Connect wallet
          </button>
        </>
      ) : (
        <>
          <div className="info-row">
            <span>Wallet</span>
            <b className="mono" title={address}>
              {shortAddress(address)}
            </b>
          </div>
          <div className="info-row">
            <span>World ID</span>
            <b>
              {approver.isPending
                ? "Checking…"
                : approver.error
                  ? statusOf(approver.error) === 404 && !(approver.error as Error & { reason?: string }).reason
                    ? "Approvals not served by this relay"
                    : `Unknown (${errorText(approver.error as Error)})`
                  : approver.data?.linked
                    ? `Linked${approver.data.linkedAt ? ` on ${new Date(approver.data.linkedAt * (approver.data.linkedAt < 1e12 ? 1000 : 1)).toLocaleDateString()}` : ""}`
                    : "Not linked"}
            </b>
          </div>
          {approver.data && !approver.data.linked && (
            <>
              <p className="appr-note">
                Approving a paused agent needs your wallet and a Selfie Check from the World ID linked here. Link it once; later approvals must come from the same person.
              </p>
              {world && !world.configured && <p className="form-hint">World ID isn&apos;t set up on this relay ({world.problems.join("; ") || "missing WORLD_* settings"}).</p>}
              <div className="appr-actions">
                <button type="button" className="primary" disabled={busy || (!!world && !world.configured)} onClick={() => void flow.start()}>
                  {flow.phase === "failed" ? "Start again" : "Link World ID"}
                </button>
                {busy && (
                  <button type="button" className="secondary" onClick={() => void flow.cancel()}>
                    Cancel
                  </button>
                )}
              </div>
            </>
          )}
          <FlowSteps flow={flow} world doneText="Linked. Future approvals must come from this World ID." failedText="Not linked" />
        </>
      )}
    </article>
  );
}
