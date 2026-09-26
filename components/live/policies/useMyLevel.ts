"use client";

import { addresses } from "@/lib/ens/contracts";
import { type RelayNode, useRelayNode } from "@/lib/hooks/useRelayNode";

import { useLive } from "../LiveContext";
import { pickMyLevel } from "./policy-logic";

/**
 * "Your level" per SRC AdminApp: the selected name if you own it with people under it,
 * otherwise the company root if it's yours. Also returns the root's chain state
 * (its resolver bounds what a delegate grant covers).
 */
export function useMyLevel(): { myNode: RelayNode | null; rootNode: RelayNode } {
  const { root, selected } = useLive();
  const rootNode = useRelayNode(root ? { name: root, registry: addresses.ETHRegistry } : null);
  const selectedNode = useRelayNode(selected && selected.name !== root ? { name: selected.name, registry: selected.registry } : null);
  return { myNode: pickMyLevel(selectedNode, rootNode), rootNode };
}
