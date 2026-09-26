"use client";

import { useEffect, useRef } from "react";

import { useMyResolver } from "@/lib/hooks/useMyResolver";

import { useLive } from "../LiveContext";
import { DelegatesCard } from "./DelegatesCard";
import { PlansCard } from "./PlansCard";
import { useMyLevel } from "./useMyLevel";

/** Live "04 Policies": plans (SRC Plans, F11) and delegates (SRC Delegates, F12) for your level. */
export function PoliciesView() {
  const { refresh, log, toast } = useLive();
  const { myNode, rootNode } = useMyLevel();
  // One resolver hook for both cards, so a single deploy unlocks both.
  const my = useMyResolver();

  // useMyResolver runs the deploy itself; announce it once it lands.
  const deployedHash = my.tx.state.status === "success" ? my.tx.state.hash : null;
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (!deployedHash || announced.current === deployedHash) return;
    announced.current = deployedHash;
    void refresh();
    log("Resolver deployed", my.resolver ?? "Your resolver");
    toast("Resolver deployed on Sepolia.");
  }, [deployedHash, my.resolver, refresh, log, toast]);

  return (
    <div className="live-policies">
      <PlansCard myNode={myNode} my={my} />
      <DelegatesCard myNode={myNode} my={my} companyResolver={rootNode.resolver} />
    </div>
  );
}
