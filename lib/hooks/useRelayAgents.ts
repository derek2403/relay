"use client";

import { useCallback } from "react";
import { type Address, isAddressEqual } from "viem";

import { AGENT_KEYS_STORAGE, type StoredAgentKey, findAgentKey } from "@/lib/relay/browser";

import { useLocalJson } from "./useLocalJson";

const NO_KEYS: StoredAgentKey[] = [];

/** Agent keys generated in this browser (localStorage), shared by every component. */
export function useRelayAgentKeys() {
  const [keys, setKeys] = useLocalJson<StoredAgentKey[]>(AGENT_KEYS_STORAGE, NO_KEYS);

  const add = useCallback(
    (key: StoredAgentKey) => setKeys([key, ...keys.filter((k) => !isAddressEqual(k.address, key.address))]),
    [keys, setKeys],
  );
  const remove = useCallback(
    (address: Address) => setKeys(keys.filter((k) => !isAddressEqual(k.address, address))),
    [keys, setKeys],
  );
  const find = useCallback((address: Address | null | undefined) => findAgentKey(keys, address), [keys]);

  return { keys, add, remove, find };
}
