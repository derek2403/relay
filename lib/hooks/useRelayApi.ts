"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { RelayApiError, relayApi } from "@/lib/relay/browser";

// React Query wrappers for the relay's HTTP API (same origin).
// Tree reads cost the server several RPC round trips each, so they don't refetch on
// window focus; useRelayRefresh (after every write) and the Refresh button update them.

export function useRelayStatus() {
  return useQuery({ queryKey: ["relay-status"], queryFn: relayApi.status, staleTime: 30_000, retry: 1 });
}

/** Query options for a children listing, shared so every reader hits the same cache entry. */
export const childrenQuery = (name: string | null, enabled = true) => ({
  queryKey: ["relay-children", name] as const,
  queryFn: () => relayApi.children(name!),
  enabled: !!name && enabled,
  // The first listing of a registry scans its logs and answers 503 "still scanning" until done.
  retry: (count: number, err: Error) => (err instanceof RelayApiError && err.status === 503 ? count < 10 : count < 1),
  retryDelay: 2_000,
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});

export function useRelayChildren(name: string | null, enabled = true) {
  return useQuery(childrenQuery(name, enabled));
}

/**
 * What the relay would decide for `name` right now, with per-level spend. With `intervalMs`,
 * re-read while the tab is visible (spend moves as agents call), until the relay says sign in.
 */
export function useRelayPolicy(name: string | null, provider?: string, intervalMs?: number | false) {
  return useQuery({
    queryKey: ["relay-policy", name, provider ?? null],
    queryFn: () => relayApi.policy(name!, provider),
    enabled: !!name,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) =>
      !intervalMs || (query.state.error instanceof RelayApiError && (query.state.error.status === 401 || query.state.error.status === 403))
        ? false
        : intervalMs,
    refetchIntervalInBackground: false,
  });
}

/** The relay's recent decisions, polled while the tab is visible. */
export function useRelayLog(limit = 20, intervalMs = 5_000) {
  return useQuery({
    queryKey: ["relay-log", limit],
    queryFn: () => relayApi.log(limit),
    refetchInterval: intervalMs,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Queries whose answer can change when this page sends a transaction. */
const CHAIN_STATE_KEYS = new Set(["relay-bundle", "relay-children", "relay-policy", "readContract", "readContracts", "getBytecode"]);

/**
 * Refetches the chain reads and relay API answers a write can change, so
 * checklists and the tree reflect the new chain state. Balances, ENS lookups,
 * the relay status and the (polled) log are left alone.
 */
export function useRelayRefresh() {
  const queryClient = useQueryClient();
  return useCallback(
    () => queryClient.invalidateQueries({ predicate: (q) => CHAIN_STATE_KEYS.has(String(q.queryKey[0])) }),
    [queryClient],
  );
}
