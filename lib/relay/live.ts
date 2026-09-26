// Live kill: calls in flight re-check that their name is still alive.
//
// A call is checked when it starts, but a response can stream for minutes.
// While it runs, the relay re-reads the caller's chain every
// RELAY_LIVE_CHECK_SEC seconds: every level must still be registered and the
// leaf still owned by the token's signer. Removing any level (unregister sets
// its expiry to now) or letting it expire ends the call within one interval.
//
// Checks are shared per name: ten streams for one agent cost one chain read
// per interval, not ten. A chain read that fails keeps the calls running (a
// flaky RPC must not cut off live work); the next interval tries again.

import { type Address, isAddressEqual } from "viem";

import { type ChainLevel, type ChainReader, isChainReadError } from "./ens";
import { firstDeadLevel, revokedReason } from "./policy";

type Watcher = { signer: Address; onRevoked: (reason: string) => void };

type Entry = {
  root: string;
  name: string;
  watchers: Set<Watcher>;
  timer: ReturnType<typeof setInterval>;
  running: boolean;
};

/** Why these levels no longer let `signer` act as `name`, or null while they do. */
export function revokedIn(levels: ChainLevel[], name: string, signer: Address): string | null {
  const dead = firstDeadLevel(levels);
  if (dead) return revokedReason(dead.name);
  const leaf = levels[levels.length - 1];
  if (!leaf?.owner || !isAddressEqual(leaf.owner, signer)) return `access revoked: ${signer} no longer owns ${name}. Run ./relay login.`;
  return null;
}

export class LiveChecker {
  private entries = new Map<string, Entry>();

  constructor(
    readonly reader: ChainReader,
    readonly intervalMs: number,
  ) {}

  /** Names being watched right now (for tests and status). */
  get watching(): number {
    return this.entries.size;
  }

  /**
   * Calls `onRevoked` (once) when `signer` may no longer act as `name`.
   * Returns a function that stops watching; call it when the call ends.
   */
  watch(opts: { root: string; name: string; signer: Address }, onRevoked: (reason: string) => void): () => void {
    const key = `${opts.root}|${opts.name}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const created: Entry = {
        root: opts.root,
        name: opts.name,
        watchers: new Set(),
        running: false,
        timer: setInterval(() => void this.tick(key, created), this.intervalMs),
      };
      created.timer.unref?.();
      this.entries.set(key, created);
      entry = created;
    }
    const watcher: Watcher = { signer: opts.signer, onRevoked };
    entry.watchers.add(watcher);
    const owner = entry;
    return () => {
      owner.watchers.delete(watcher);
      if (owner.watchers.size === 0 && this.entries.get(key) === owner) this.stop(key, owner);
    };
  }

  private stop(key: string, entry: Entry) {
    clearInterval(entry.timer);
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }

  private async tick(key: string, entry: Entry) {
    // A slow read skips ticks instead of piling up.
    if (entry.running || entry.watchers.size === 0) return;
    entry.running = true;
    try {
      const levels = await this.reader.readLevels(entry.root, entry.name);
      for (const w of [...entry.watchers]) {
        const reason = revokedIn(levels, entry.name, w.signer);
        if (!reason) continue;
        entry.watchers.delete(w);
        try {
          w.onRevoked(reason);
        } catch (err) {
          console.error("[relay] live kill failed:", err);
        }
      }
      if (entry.watchers.size === 0) this.stop(key, entry);
    } catch (err) {
      if (!isChainReadError(err)) console.error("[relay] live check failed:", err instanceof Error ? err.message : err);
    } finally {
      entry.running = false;
    }
  }
}

// One checker per chain reader and interval, kept on globalThis so dev-server reloads share them.
const g = globalThis as unknown as { __relayLive?: WeakMap<ChainReader, Map<number, LiveChecker>> };

/** The shared checker for this reader, or null when live checks are off. */
export function liveCheckerFor(reader: ChainReader, intervalMs: number | null): LiveChecker | null {
  if (!intervalMs) return null;
  g.__relayLive ??= new WeakMap();
  let byInterval = g.__relayLive.get(reader);
  if (!byInterval) g.__relayLive.set(reader, (byInterval = new Map()));
  let checker = byInterval.get(intervalMs);
  if (!(checker instanceof LiveChecker)) byInterval.set(intervalMs, (checker = new LiveChecker(reader, intervalMs)));
  return checker;
}
