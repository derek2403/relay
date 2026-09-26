"use client";

import { useCallback, useSyncExternalStore } from "react";

// A tiny localStorage-backed store that lets feature pages share what the
// user created on other pages (a name registered on the ETH Registrar page,
// a resolver deployed on the Verifiable Factory page, ...) as quick picks.

export type WorkspaceKind = "names" | "resolvers" | "registries" | "registrars";

export type WorkspaceEntry = { value: string; label?: string; addedAt: number };

export type Workspace = Record<WorkspaceKind, WorkspaceEntry[]>;

const KEY = "ensv2-playground:workspace";
const EMPTY: Workspace = { names: [], resolvers: [], registries: [], registrars: [] };

const listeners = new Set<() => void>();
let cache: { raw: string | null; value: Workspace } = { raw: null, value: EMPTY };

function read(): Workspace {
  if (typeof window === "undefined") return EMPTY;
  const raw = window.localStorage.getItem(KEY);
  if (raw !== cache.raw) {
    try {
      cache = { raw, value: raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY };
    } catch {
      cache = { raw, value: EMPTY };
    }
  }
  return cache.value;
}

function write(next: Workspace) {
  window.localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => e.key === KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useWorkspace() {
  const workspace = useSyncExternalStore(subscribe, read, () => EMPTY);

  const add = useCallback((kind: WorkspaceKind, value: string, label?: string) => {
    const current = read();
    const key = value.toLowerCase();
    const rest = current[kind].filter((e) => e.value.toLowerCase() !== key);
    write({ ...current, [kind]: [{ value, label, addedAt: Date.now() }, ...rest] });
  }, []);

  const remove = useCallback((kind: WorkspaceKind, value: string) => {
    const current = read();
    write({ ...current, [kind]: current[kind].filter((e) => e.value.toLowerCase() !== value.toLowerCase()) });
  }, []);

  return { workspace, add, remove };
}
