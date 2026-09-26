"use client";

import { useCallback, useSyncExternalStore } from "react";

// JSON value in localStorage, shared by every component using the same key
// and kept in sync across tabs. Returns `fallback` on the server and when unset.

const listeners = new Set<() => void>();
const cache = new Map<string, { raw: string | null; value: unknown }>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function snapshot(key: string): unknown {
  const raw = window.localStorage.getItem(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value;
  let value: unknown = null;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    value = null;
  }
  cache.set(key, { raw, value });
  return value;
}

export function useLocalJson<T>(key: string | null, fallback: T): [T, (next: T | null) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => (key ? snapshot(key) : null),
    () => null,
  );

  const set = useCallback(
    (next: T | null) => {
      if (!key) return;
      if (next === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(next));
      listeners.forEach((l) => l());
    },
    [key],
  );

  return [(value as T | null) ?? fallback, set];
}
