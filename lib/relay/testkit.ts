// Shared fakes for the relay's unit tests (not used by the app): a company
// tree held in memory, a local fake upstream, and helpers to call the relay.

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import type { Address } from "viem";

import { RECORD_KEYS, parseBundle } from "./bundle";
import { loadConfig } from "./config";
import type { ChainLevel, ChainReader } from "./ens";
import type { GuardLevel, Overlay, Pause, RelayGuard } from "./guard";
import { Meter } from "./meter";
import { type RelayDeps, handleRelayRequest } from "./providers";
import { createLimits } from "./ratelimit";
import { createToken } from "./token";
import type { LogEntry } from "./types";

type Limits = { caps?: Record<string, number>; maxes?: Record<string, number>; period?: string };

/** A bundle from "a,b,c" and optional dollar caps, count caps and period. */
export const bundle = (keys: string, limits: Limits = {}) =>
  parseBundle({
    [RECORD_KEYS.keys]: keys,
    [RECORD_KEYS.period]: limits.period ?? "month",
    ...Object.fromEntries(Object.entries(limits.caps ?? {}).map(([p, v]) => [RECORD_KEYS.cap(p), String(v)])),
    ...Object.fromEntries(Object.entries(limits.maxes ?? {}).map(([p, v]) => [RECORD_KEYS.max(p), String(v)])),
  });

/** A chain level for MemoryChain; `extra` overrides anything, e.g. `{ chain: '{"v":1,...}' }` for a relay.chain record. */
export function level(name: string, owner: Address | null, b: ReturnType<typeof bundle>, extra: Partial<ChainLevel> = {}): ChainLevel {
  return {
    name,
    registry: "0x0000000000000000000000000000000000000001",
    resolver: "0x0000000000000000000000000000000000000002",
    subregistry: null,
    status: "registered",
    owner,
    expiry: 2_000_000_000,
    resource: "7",
    bundle: b,
    nbf: null,
    checks: { registryVerified: true, resolverVerified: true, canonical: true },
    ...extra,
  };
}

/**
 * A chain held in memory. `remove(name)` unregisters a level the way ENSv2 does:
 * it reads "available" and every level below it "missing".
 */
export class MemoryChain implements ChainReader {
  reads = 0;
  private removed = new Set<string>();
  constructor(readonly levels: ChainLevel[]) {}

  remove(name: string) {
    this.removed.add(name);
  }

  restore(name: string) {
    this.removed.delete(name);
  }

  async readLevels(root: string, name: string): Promise<ChainLevel[]> {
    this.reads++;
    // Every level from the root down to the name; unknown ones read as "missing", like the real reader.
    const labels = name.split(".");
    const depth = labels.length - root.split(".").length;
    const chain: ChainLevel[] = [];
    for (let i = depth; i >= 0; i--) {
      const n = labels.slice(i).join(".");
      chain.push(this.levels.find((l) => l.name === n) ?? level(n, null, null, { status: "missing", registry: null, resolver: null, resource: null }));
    }
    let dead = false;
    return chain.map((l) => {
      if (dead) return { ...l, status: "missing", owner: null, registry: null, resolver: null, bundle: null };
      if (this.removed.has(l.name)) {
        dead = true;
        return { ...l, status: "available", owner: null };
      }
      return l;
    });
  }
}

/**
 * A RelayGuard held in memory. `pause(name, incidentId)` suspends a name and
 * everything below it; `overlay(o)` adds an approved scope; `broken` makes it
 * report itself unavailable. `observed` counts observe() calls.
 */
export class MemoryGuard implements RelayGuard {
  pauses: Pause[] = [];
  scopes: Overlay[] = [];
  broken: string | null = null;
  observed = 0;

  pause(name: string, incidentId = "inc_test", reason = "test") {
    this.pauses.push({ incidentId, name, reason });
    return this;
  }

  overlay(o: Partial<Overlay> & Pick<Overlay, "name">) {
    const id = o.id ?? `ov_${this.scopes.length + 1}`;
    this.scopes.push({ id, after: o.name, bundle: null, chain: null, notAfter: nowSec() + 3600, bucket: `approval:${id}`, ...o });
    return this;
  }

  paused(levels: GuardLevel[]): Pause | null {
    return this.pauses.find((p) => levels.some((l) => l.name === p.name)) ?? null;
  }

  overlays(levels: GuardLevel[]): Overlay[] {
    return this.scopes.filter((o) => levels.some((l) => l.name === o.after));
  }

  observe() {
    this.observed++;
  }

  unavailable() {
    return this.broken;
  }
}

export function tempDir(prefix = "relay-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeDeps(reader: ChainReader, env: Record<string, string> = {}): RelayDeps {
  const dir = tempDir();
  return {
    config: loadConfig({ RELAY_ROOT_NAME: "acme.eth", RELAY_DATA_DIR: dir, ...env }),
    reader,
    meter: new Meter(path.join(dir, "relay.json"), 5),
    limits: createLimits(),
    live: null,
  };
}

type Signer = Parameters<typeof createToken>[0];

export const nowSec = () => Math.floor(Date.now() / 1000);

export const tokenFor = (signer: Signer, name: string, ttl = 3600) => createToken(signer, { name, iat: nowSec(), exp: nowSec() + ttl });

export type CallInit = { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; kr: string; query?: string };

/** Calls the relay in process. The body is left unread: use `res`. */
export async function relay(deps: RelayDeps, provider: string, p: string, init: CallInit) {
  const method = init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = { "x-api-key": init.kr, ...(init.raw === undefined ? { "content-type": "application/json" } : {}), ...init.headers };
  return handleRelayRequest(
    new Request(`http://localhost:3000/api/relay/${provider}${p}${init.query ?? ""}`, {
      method,
      headers,
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
    }),
    provider,
    deps,
  );
}

/** Calls the relay and reads the whole body. */
export async function relayJson(deps: RelayDeps, provider: string, p: string, init: CallInit) {
  const res = await relay(deps, provider, p, init);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, status: res.status, text, json, reason: typeof json?.reason === "string" ? json.reason : null, error: typeof json?.error === "string" ? json.error : null };
}

export async function waitForLog(meter: Meter, n = 1, timeoutMs = 3000): Promise<LogEntry[]> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const entries = meter.recent(100);
    if (entries.length >= n) return entries;
    if (Date.now() > until) throw new Error(`expected ${n} log entries, got ${entries.length}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A local HTTP server; `handle` answers each request after its body is read. */
export async function fakeUpstream(handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      handle(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    last: () => seen[seen.length - 1],
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
