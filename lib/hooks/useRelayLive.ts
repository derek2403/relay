"use client";

import { type QueryClient, keepPreviousData, useQuery } from "@tanstack/react-query";
import { type Address, isAddressEqual } from "viem";

import { relayApi } from "@/lib/relay/browser";
import type { ChildrenResponse, LevelView } from "@/lib/relay/types";

import { childrenQuery } from "./useRelayApi";

/** How often the live view asks the relay for spend. */
export const LIVE_POLL_MS = 3_000;
/** Children listings cost the relay more (log scans), so new agents are looked for half as often. */
const DISCOVER_MS = 6_000;

export type LiveData = {
  user: string;
  /** Names under the user, parent -> children (its agents, then their subagents). A name seen once stays listed. */
  kids: Record<string, string[]>;
  /** The subname registry each listed parent had, to notice a name re-created with a fresh registry. */
  registries: Record<string, Address>;
  /**
   * Latest relay view of every level from the company down, by name. A level
   * the chain no longer shows (removed, or cut off above) keeps its last bundle
   * and spend, so the view can show what was revoked.
   */
  levels: Record<string, LevelView>;
  /** The expiry each name had when last seen live: tells "ended" (ran out) from "revoked" (removed). */
  liveExpiry: Record<string, number | null>;
  discoveredAt: number;
  /** Unix ms when this view saw the user re-registered; log entries before it belong to the previous holder. */
  since: number;
  /** Unix ms of the last successful round. */
  updatedAt: number;
  /** Some reads failed this round; what's shown for them is from an earlier round. */
  partialError: string | null;
};

/** The user, then each agent followed by its subagents. */
export function subtreeNames(user: string, kids: Record<string, string[]>): string[] {
  const out: string[] = [];
  const walk = (name: string, depth: number) => {
    out.push(name);
    if (depth < 2) for (const kid of kids[name] ?? []) walk(kid, depth + 1);
  };
  walk(user, 0);
  return out;
}

const hasAny = (r: Partial<Record<string, number>> | undefined) => !!r && Object.values(r).some((v) => (v ?? 0) > 0);

type Listing = ChildrenResponse | Error | null;

/**
 * Children to show under `parent`: the registered ones now, plus every name
 * shown before while the parent's registry is the same. When the parent can't
 * be listed (removed, so its registry is unreachable), the old names stay.
 */
function mergeKids(parent: string, listing: Listing, prev: LiveData | undefined) {
  const before = prev?.kids[parent] ?? [];
  const prevRegistry = prev?.registries[parent];
  if (!listing || listing instanceof Error || !listing.registry) return { kids: before, registry: prevRegistry };
  const registered = listing.children.filter((c) => c.status === "registered").map((c) => c.name);
  const kept = prevRegistry && isAddressEqual(prevRegistry, listing.registry) ? before : [];
  return { kids: [...new Set([...kept, ...registered])], registry: listing.registry };
}

/** Listings this view fetched, shared with the tree (same cache entry as useRelayChildren). */
type OnListing = (name: string, listing: ChildrenResponse) => void;

async function discover(user: string, prev: LiveData | undefined, onListing?: OnListing) {
  const kids: Record<string, string[]> = {};
  const registries: Record<string, Address> = {};
  const errors: string[] = [];
  const note = (listing: Listing) => listing instanceof Error && errors.push(listing.message);
  const keep = (parent: string, merged: ReturnType<typeof mergeKids>) => {
    if (merged.kids.length) kids[parent] = merged.kids;
    if (merged.registry) registries[parent] = merged.registry;
  };

  const list = (name: string) =>
    relayApi.children(name).then(
      (listing) => {
        onListing?.(name, listing);
        return listing;
      },
      (e: Error) => e,
    );
  const top = await list(user);
  note(top);
  const agents = mergeKids(user, top, prev);
  keep(user, agents);

  // Only agents with names below them (or that had some) need a listing of their own.
  const withNames = new Set(top && !(top instanceof Error) ? top.children.filter((c) => c.subregistry).map((c) => c.name) : []);
  const lists = await Promise.all(
    agents.kids.map((agent) => (withNames.has(agent) || prev?.kids[agent]?.length ? list(agent) : null)),
  );
  agents.kids.forEach((agent, i) => {
    note(lists[i]);
    keep(agent, mergeKids(agent, lists[i], prev));
  });
  return { kids, registries, errors };
}

async function poll(user: string, prevAny: LiveData | undefined, onListing?: OnListing): Promise<LiveData> {
  const now = Date.now();
  let prev = prevAny?.user === user ? prevAny : undefined;
  const errors: string[] = [];

  let kids: LiveData["kids"] = prev?.kids ?? {};
  let registries: LiveData["registries"] = prev?.registries ?? {};
  let discoveredAt = prev?.discoveredAt ?? 0;
  if (now - discoveredAt >= DISCOVER_MS) {
    const found = await discover(user, prev, onListing);
    ({ kids, registries } = found);
    errors.push(...found.errors);
    discoveredAt = now;
  }

  // A leaf's policy lists every level from the company down to it, so polling
  // the leaves alone covers the user, its agents and everything above.
  const names = subtreeNames(user, kids);
  const leaves = names.filter((n) => !kids[n]?.length);
  const results = await Promise.allSettled(leaves.map((n) => relayApi.policy(n)));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  // Nothing readable: keep the last good round on screen and report why.
  if (failed.length === results.length) throw failed[0].reason;
  errors.push(...failed.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason))));

  const fresh: Record<string, LevelView> = {};
  for (const r of results) if (r.status === "fulfilled") for (const level of r.value.levels) fresh[level.name] = level;

  // Re-registered (a new EAC resource): the old agents and spend belong to the previous holder.
  const was = prev?.levels[user];
  const nowUser = fresh[user];
  let since = prev?.since ?? 0;
  if (was?.resource && nowUser?.status === "registered" && nowUser.resource && nowUser.resource !== was.resource) {
    prev = undefined;
    since = now;
    kids = {};
    registries = {};
    discoveredAt = 0;
  }

  const levels: Record<string, LevelView> = { ...(prev?.levels ?? {}) };
  const liveExpiry: Record<string, number | null> = { ...(prev?.liveExpiry ?? {}) };
  for (const [name, level] of Object.entries(fresh)) {
    if (level.status === "registered") {
      levels[name] = level;
      liveExpiry[name] = level.expiry;
      continue;
    }
    // Removed or cut off: getResolver now returns 0, so the bundle can't be read any more.
    const old = levels[name];
    levels[name] = {
      ...level,
      bundle: level.bundle ?? old?.bundle ?? null,
      spent: hasAny(level.spent) ? level.spent : (old?.spent ?? {}),
      used: hasAny(level.used) ? level.used : old?.used,
    };
  }

  return { user, kids, registries, levels, liveExpiry, discoveredAt, since, updatedAt: now, partialError: errors[0] ?? null };
}

const liveQueryKey = (user: string | null) => ["relay-live", user] as const;

/** Whether this page has seen `user` registered (its live data is still cached). */
export const wasSeenLive = (client: QueryClient, user: string) => client.getQueryData<LiveData>(liveQueryKey(user))?.liveExpiry[user] !== undefined;

/**
 * The live view's data for one user: its subtree (user -> agents ->
 * subagents) and every level above it, with spend and counts, refreshed every
 * 3 s while the tab is visible (React Query pauses interval refetches in a
 * hidden tab).
 */
export function useRelayLive(user: string | null) {
  return useQuery({
    queryKey: liveQueryKey(user),
    // Each round builds on the previous one (names seen before, last known limits).
    // Listings found on the way go into the children cache too, so the tree shows new agents
    // and subagents as soon as this view does, without extra requests.
    queryFn: ({ client, queryKey }) =>
      poll(user!, client.getQueryData<LiveData>(queryKey), (name, listing) => client.setQueryData(childrenQuery(name).queryKey, listing)),
    enabled: !!user,
    // Kept while the view is closed (e.g. on another tab), so a user removed meanwhile still
    // reads as "revoked" (seen live here) rather than "not registered".
    gcTime: 60 * 60_000,
    refetchInterval: LIVE_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    retry: false,
  });
}
