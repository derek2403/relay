"use client";

import type { useMyResolver } from "@/lib/hooks/useMyResolver";

import { TxButton } from "../tx/TxButton";
import { TxStatus } from "../tx/TxStatus";

/** The shared "deploy your resolver first" precondition (SRC Plans / Delegates). */
export function DeployResolver({ my, reason }: { my: ReturnType<typeof useMyResolver>; reason: string }) {
  if (my.loading) return <p className="form-hint">Checking your resolver…</p>;
  return (
    <div className="live-policy-deploy">
      <p className="form-hint">{reason}</p>
      <div className="live-policy-actions">
        <TxButton tx={my.tx} variant="primary" onClick={() => void my.deploy()}>
          Deploy my resolver
        </TxButton>
      </div>
      <TxStatus tx={my.tx} />
    </div>
  );
}
