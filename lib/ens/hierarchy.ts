// Walks the ENSv2 registry tree for a name, the same way the Universal
// Resolver does (see /ensv2/registry-hierarchy#resolution): start at the
// RootRegistry and follow getSubregistry(label) one label at a time, right to
// left. Works for any registry implementing IRegistry.

import { type Address, type PublicClient, parseAbi, zeroAddress } from "viem";

import { ENSV2_SEPOLIA } from "./deployments";
import { splitLabels } from "./names";

export const ROOT_REGISTRY = ENSV2_SEPOLIA.RootRegistry.address;

export const iRegistryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getResolver(string label) view returns (address)",
  "function getParent() view returns (address parent, string label)",
]);

export type Hop = {
  /** Name at this level, e.g. "nick.eth". */
  name: string;
  /** Leftmost label of `name`, e.g. "nick". */
  label: string;
  /** Registry holding `label`. */
  registry: Address;
  /** Child registry of `name`, or null if unset. */
  subregistry: Address | null;
  /** Resolver set for `name` in `registry`, or null if unset. */
  resolver: Address | null;
};

export type HierarchyWalk = {
  hops: Hop[];
  /**
   * True when a registry was reached for every label, i.e. the registry that
   * holds (or would hold) the leftmost label is known. The label itself may
   * still be unregistered; check getState on `registry`.
   */
  complete: boolean;
  /** Registry that holds (or would hold) the leftmost label, when `complete`. */
  registry: Address | null;
  /** Nearest resolver seen on the way down (what resolution would use). */
  resolver: Address | null;
  /** Name whose resolver was used, e.g. "nick.eth" for a wildcard on "sub.nick.eth". */
  resolverName: string | null;
};

const orNull = (a: Address) => (a === zeroAddress ? null : a);

export async function walkHierarchy(client: PublicClient, name: string, root: Address = ROOT_REGISTRY): Promise<HierarchyWalk> {
  const labels = splitLabels(name);
  const hops: Hop[] = [];
  let registry: Address | null = root;
  let resolver: Address | null = null;
  let resolverName: string | null = null;

  for (let i = labels.length - 1; i >= 0 && registry; i--) {
    const label = labels[i];
    const [sub, res] = await Promise.all([
      client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getSubregistry", args: [label] }),
      client.readContract({ address: registry, abi: iRegistryAbi, functionName: "getResolver", args: [label] }),
    ]);
    const hop: Hop = { name: labels.slice(i).join("."), label, registry, subregistry: orNull(sub), resolver: orNull(res) };
    hops.push(hop);
    if (hop.resolver) {
      resolver = hop.resolver;
      resolverName = hop.name;
    }
    registry = hop.subregistry;
  }

  const complete = hops.length === labels.length && labels.length > 0;
  return { hops, complete, registry: complete ? hops[hops.length - 1].registry : null, resolver, resolverName };
}
