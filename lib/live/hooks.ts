"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";

import { RelayApiError, getJson, relayApi } from "@/lib/relay/browser";
import type { OwnedResponse } from "@/lib/relay/types";

/** Unix seconds, refreshed every `intervalMs` (expiry in the tree doesn't need a 1 s tick). 0 until mounted. */
export function useClock(intervalMs = 15_000) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [intervalMs]);
  return now;
}

/**
 * useRelayLog (lib/hooks/useRelayApi.ts) that stays idle while `enabled` is false: a relay whose
 * viewAuth is "closed" (production without RELAY_ADMIN_TOKEN) answers 401 to every browser read.
 * Same query key, so it shares the cache with the Agents view's log.
 */
export function useLiveLog(limit: number, intervalMs: number, enabled: boolean) {
  return useQuery({
    queryKey: ["relay-log", limit],
    queryFn: () => relayApi.log(limit),
    enabled,
    refetchInterval: enabled ? intervalMs : false,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/**
 * GET /api/ens/owned: the names under RELAY_ROOT_NAME an address holds (deepest first).
 * Only asked when the relay has a root; 503 "still scanning" is retried.
 */
export function useOwnedNames(address: Address | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["relay-owned", address ?? null],
    queryFn: () => getJson<OwnedResponse>(`/api/ens/owned?address=${address}`),
    enabled: !!address && enabled,
    retry: (count: number, err: Error) => err instanceof RelayApiError && err.status === 503 && count < 5,
    retryDelay: 3_000,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
