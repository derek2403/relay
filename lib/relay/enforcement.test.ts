// Relay enforcement against a local fake upstream: reservations, route rules,
// no-usage and disconnect charging, headers, body limits, the log, token rules
// and the GitHub/Railway filters.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { RECORD_KEYS, parseBundle } from "./bundle";
import { loadConfig } from "./config";
import type { ChainLevel, ChainReader } from "./ens";
import { Meter } from "./meter";
import { type RelayDeps, handleRelayRequest } from "./providers";
import { ClientLimit, createLimits } from "./ratelimit";
import { createToken } from "./token";
import type { LogEntry } from "./types";

const CLAUDE_KEY = "sk-ant-api03-REAL-KEY-never-leak-0123456789";
const OPENAI_KEY = "sk-proj-REAL-OPENAI-KEY-0123456789";
const GITHUB_KEY = "ghp_REAL_GITHUB_TOKEN_0123456789";
const RAILWAY_KEY = "rw_REAL_RAILWAY_TOKEN_0123456789";

// --- Fake upstream ------------------------------------------------------------------

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string; aborted: boolean };
const seen: Seen[] = [];
let upstream = "";
let server: http.Server;
const releases: (() => void)[] = [];

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const MESSAGE_START = sse("message_start", { type: "message_start", message: { model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 1 } } });
const MESSAGE_END =
  sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } }) + sse("message_stop", { type: "message_stop" });

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString(), aborted: false };
      seen.push(entry);
      res.on("close", () => {
        if (!res.writableFinished) entry.aborted = true;
      });
      const mode = String(req.headers["x-test"] ?? "");
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      };
      const url = req.url!.split("?")[0];
      if (url === "/v1/messages") {
        if (mode === "nousage") return json(200, { type: "message", model: "claude-opus-5", content: [] });
        if (mode === "slow-json") {
          setTimeout(() => !res.destroyed && json(200, { type: "message", model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 100 } }), 300);
          return;
        }
        if (mode === "slow-sse") {
          setTimeout(() => {
            if (res.destroyed) return;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(MESSAGE_START + MESSAGE_END);
          }, 300);
          return;
        }
        if (mode === "hold-sse") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(MESSAGE_START);
          releases.push(() => !res.destroyed && res.end(MESSAGE_END));
          return;
        }
        return json(
          200,
          { type: "message", model: "claude-opus-5", usage: { input_tokens: 1000, output_tokens: 100 } },
          { "anthropic-organization-id": "org-secret-123", "request-id": "req_1" },
        );
      }
      if (url === "/v1/messages/count_tokens") return json(200, { input_tokens: 5 });
      if (url === "/v1/models/redirect") {
        res.writeHead(301, { location: `${upstream}/v1/models/new?x=1`, "x-echo": `key ${req.headers["x-api-key"]}` });
        return res.end();
      }
      if (url === "/v1/models/elsewhere") {
        res.writeHead(302, { location: "https://cdn.example.com/file" });
        return res.end();
      }
      if (url === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream", "openai-organization": "org-x", "openai-project": "proj-x" });
        res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "gpt-5", choices: [{ delta: { content: "hi" } }] })}\n\n`);
        const body = JSON.parse(entry.body);
        if (body.stream_options?.include_usage) {
          res.write(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: "gpt-5", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\n`);
        }
        return res.end("data: [DONE]\n\n");
      }
      if (url === "/v1/responses") return json(200, { object: "response", model: "gpt-5", usage: { input_tokens: 100, output_tokens: 10 } });
      if (url === "/user" || url.startsWith("/repos/")) return json(200, { login: "acme-bot" });
      if (url === "/graphql/v2") return json(200, { data: {} });
      return json(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  releases.forEach((r) => r());
  server.closeAllConnections();
  server.close();
});

// --- Relay setup ----------------------------------------------------------------------

const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const LEAF = "laptop.derek.acme.eth";

const bundle = (keys: string, caps: Record<string, number> = {}, period = "total") =>
  parseBundle({ [RECORD_KEYS.keys]: keys, [RECORD_KEYS.period]: period, ...Object.fromEntries(Object.entries(caps).map(([p, v]) => [RECORD_KEYS.cap(p), String(v)])) });

function level(name: string, owner: Address, b: ReturnType<typeof bundle>, extra: Partial<ChainLevel> = {}): ChainLevel {
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

const ALL = "claude,codex,github,railway,mock";

function deps(opts: { leaf?: ReturnType<typeof bundle>; leafExtra?: Partial<ChainLevel>; env?: Record<string, string>; meter?: Meter } = {}): RelayDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-enf-"));
  const levels = [
    level("acme.eth", stranger.address, bundle(ALL, { claude: 100, codex: 100 })),
    level("derek.acme.eth", stranger.address, bundle(ALL)),
    level(LEAF, agent.address, opts.leaf ?? bundle(ALL, { claude: 10, codex: 10 }), opts.leafExtra),
  ];
  const reader: ChainReader = { readLevels: async (_root, name) => levels.filter((l) => name === l.name || name.endsWith(`.${l.name}`)) };
  return {
    config: loadConfig({
      RELAY_ROOT_NAME: "acme.eth",
      RELAY_DATA_DIR: dir,
      ANTHROPIC_API_KEY: CLAUDE_KEY,
      OPENAI_API_KEY: OPENAI_KEY,
      GITHUB_TOKEN: GITHUB_KEY,
      RAILWAY_TOKEN: RAILWAY_KEY,
      RELAY_UPSTREAM_CLAUDE: upstream,
      RELAY_UPSTREAM_CODEX: upstream,
      RELAY_UPSTREAM_GITHUB: upstream,
      RELAY_UPSTREAM_RAILWAY: upstream,
      ...opts.env,
    }),
    reader,
    meter: opts.meter ?? new Meter(path.join(dir, "relay.json"), 5),
    limits: createLimits(),
  };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const token = (signer = agent, extra: { ttl?: number; aud?: string; iat?: number } = {}) => {
  const iat = extra.iat ?? nowSec();
  return createToken(signer, { name: LEAF, iat, exp: iat + (extra.ttl ?? 3600), ...(extra.aud ? { aud: extra.aud } : {}) });
};

async function call(
  d: RelayDeps,
  provider: string,
  p: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; kr?: string; signal?: AbortSignal; raw?: BodyInit; read?: boolean } = {},
) {
  const kr = init.kr ?? (await token());
  const method = init.method ?? (init.body !== undefined || init.raw ? "POST" : "GET");
  const res = await handleRelayRequest(
    new Request(`http://localhost:3000/api/relay/${provider}${p}`, {
      method,
      headers: { "x-api-key": kr, "content-type": "application/json", ...init.headers },
      body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
      signal: init.signal,
      ...(init.raw instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit),
    provider,
    d,
  );
  // read: false leaves a successful body unread (refusals are always read).
  const text = init.read === false && res.ok ? "" : await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, status: res.status, text, json, reason: typeof json?.reason === "string" ? json.reason : null };
}

async function logEntries(meter: Meter, n = 1): Promise<LogEntry[]> {
  for (let i = 0; i < 300; i++) {
    const entries = meter.recent(50);
    if (entries.length >= n) return entries;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`expected ${n} log entries, got ${meter.recent(50).length}`);
}

const close = (a: number | null | undefined, b: number) => assert.ok(Math.abs((a ?? NaN) - b) < 1e-9, `${a} != ${b}`);
const lastSeen = () => seen[seen.length - 1];

// --- Caps ---------------------------------------------------------------------------------

test("caps: 25 concurrent mock calls against a $0.02 cap -> exactly 2 allowed, $0.02 charged", async () => {
  const d = deps({ leaf: bundle(ALL, { mock: 0.02 }) });
  const kr = await token();
  const results = await Promise.all(Array.from({ length: 25 }, () => call(d, "mock", "/v1/messages", { body: {}, kr })));
  assert.equal(results.filter((r) => r.status === 200).length, 2);
  assert.ok(results.filter((r) => r.status === 403).every((r) => /mock cap/.test(r.reason ?? "")));
  const charged = d.meter.recent(50).filter((e) => e.allowed).reduce((s, e) => s + (e.costUsd ?? 0), 0);
  close(charged, 0.02);
});

test("caps: calls whose bodies are never read still hold their reservation", async () => {
  // Worst case per call: opus-5, 800 output tokens = $0.02 (+ a little input), cap $0.05 -> 2 calls fit.
  const d = deps({ leaf: bundle(ALL, { claude: 0.05 }) });
  const body = { model: "claude-opus-5", max_tokens: 800, stream: true, messages: [] };
  const a = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "hold-sse" }, read: false });
  const b = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "hold-sse" }, read: false });
  const c = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "hold-sse" }, read: false });
  assert.deepEqual([a.status, b.status, c.status], [200, 200, 403]);
  assert.match(c.reason!, /could cost up to \$0\.02.*only \$0\.0098 is left/);
  releases.splice(0).forEach((r) => r());
  const entries = await logEntries(d.meter, 3);
  const settled = entries.filter((e) => e.allowed);
  assert.equal(settled.length, 2);
  // Settled at the real cost: 1000 input + 100 output on opus-5.
  settled.forEach((e) => close(e.costUsd, (1000 * 5 + 100 * 25) / 1e6));
  await a.res.body?.cancel();
  await b.res.body?.cancel();
});

test("caps: a call that could cost more than the budget left is refused before it is sent", async () => {
  const d = deps({ leaf: bundle(ALL, { claude: 0.01 }) });
  const before = seen.length;
  const r = await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 64000, messages: [] } });
  assert.equal(r.status, 403);
  assert.match(r.reason!, /could cost up to \$1\.60.*only \$0\.01 is left/);
  assert.equal(seen.length, before, "never reached the provider");
});

test("caps: the period is fixed when the call starts", async () => {
  const d = deps({ leaf: bundle(ALL, { claude: 10 }, "day") });
  let clock = new Date("2026-09-30T23:59:59Z");
  d.now = () => clock;
  const r = await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 100, stream: true }, headers: { "x-test": "hold-sse" }, read: false });
  assert.equal(r.status, 200);
  clock = new Date("2026-10-01T00:00:05Z");
  releases.splice(0).forEach((f) => f());
  await logEntries(d.meter);
  // Charged to Sep 30 (the day it started), so Oct 1 is untouched.
  const policy = await (await import("./policy")).decide({ name: LEAF, provider: "claude" }, d);
  assert.equal(policy.levels[2].spent.claude, 0);
  d.now = () => new Date("2026-09-30T12:00:00Z");
  const sep30 = await (await import("./policy")).decide({ name: LEAF, provider: "claude" }, d);
  close(sep30.levels[2].spent.claude, (1000 * 5 + 100 * 25) / 1e6);
  await r.res.body?.cancel();
});

test("caps: in-flight calls per name are limited", async () => {
  const d = deps({ env: { RELAY_MAX_CONCURRENT: "1" } });
  const body = { model: "claude-opus-5", max_tokens: 100, stream: true };
  const first = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "hold-sse" }, read: false });
  const second = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "hold-sse" } });
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.match(second.reason!, /already has 1 calls in flight/);
  releases.splice(0).forEach((f) => f());
  await first.res.text();
  await logEntries(d.meter, 2);
  assert.equal((await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 100 } })).status, 200);
});

// --- Routes and charging --------------------------------------------------------------------

test("routes: batches, stored-object reads and unknown endpoints are refused; count_tokens is forwarded for free", async () => {
  const d = deps();
  const before = seen.length;
  for (const [provider, method, p] of [
    ["claude", "POST", "/v1/messages/batches"],
    ["claude", "POST", "/v1/files"],
    ["codex", "POST", "/v1/batches"],
    ["codex", "GET", "/v1/responses/resp_123"],
    ["codex", "POST", "/v1/audio/speech"],
    ["codex", "POST", "/v1/fine_tuning/jobs"],
  ]) {
    const r = await call(d, provider, p, { method, body: method === "POST" ? { model: "x" } : undefined });
    assert.equal(r.status, 403, `${provider} ${method} ${p}`);
    assert.match(r.reason!, /doesn't forward/);
  }
  assert.equal(seen.length, before);

  const free = await call(d, "claude", "/v1/messages/count_tokens", { body: { model: "claude-opus-5", messages: [] } });
  assert.equal(free.status, 200);
  const [entry] = await logEntries(d.meter, 7);
  assert.equal(entry.costUsd, 0);
});

test("routes: RELAY_EXTRA_ROUTES opens more endpoints", async () => {
  const d = deps({ env: { RELAY_EXTRA_ROUTES: "claude:POST /v1/messages/batches" } });
  const r = await call(d, "claude", "/v1/messages/batches", { body: { requests: [] } });
  assert.equal(r.status, 404, "forwarded (the fake upstream has no such route)");
});

test("charging: a non-streamed success without usage is charged the call's worst case", async () => {
  const d = deps();
  const body = { model: "claude-opus-5", max_tokens: 1000, messages: [] };
  const r = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "nousage" } });
  assert.equal(r.status, 200);
  const [entry] = await logEntries(d.meter);
  const input = Math.ceil(JSON.stringify(body).length / 3);
  close(entry.costUsd, (input * 5 + 1000 * 25) / 1e6);
  assert.equal(entry.estimated, true);
});

test("charging: codex chat streams get include_usage and an output limit, and are charged from the reported usage", async () => {
  const d = deps();
  const r = await call(d, "codex", "/v1/chat/completions", { body: { model: "gpt-5", stream: true, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(r.status, 200);
  const sent = JSON.parse(lastSeen().body);
  assert.equal(sent.stream_options.include_usage, true);
  assert.equal(sent.max_completion_tokens, 32000);
  assert.equal(lastSeen().headers.authorization, `Bearer ${OPENAI_KEY}`);
  assert.equal(r.res.headers.get("openai-organization"), null);
  assert.equal(r.res.headers.get("openai-project"), null);
  const [entry] = await logEntries(d.meter);
  close(entry.costUsd, (100 * 1.25 + 10 * 10) / 1e6); // estimated gpt-5 price [1.25, 10]
  assert.equal(entry.estimated, false);
});

test("charging: without an output limit, the relay sets one the budget can pay for", async () => {
  const d = deps({ leaf: bundle(ALL, { codex: 0.05 }) });
  const r = await call(d, "codex", "/v1/responses", { body: { model: "gpt-5", input: "hello" } });
  assert.equal(r.status, 200);
  const limit = JSON.parse(lastSeen().body).max_output_tokens;
  // About $0.05 of gpt-5 output at the estimated $10 / MTok.
  assert.ok(limit > 4000 && limit < 5000, String(limit));
  const tiny = deps({ leaf: bundle(ALL, { codex: 0.001 }) });
  const refused = await call(tiny, "codex", "/v1/responses", { body: { model: "gpt-5", input: "hello" } });
  assert.equal(refused.status, 403);
  assert.match(refused.reason!, /not enough budget left/);
});

test("disconnect: a stream cut before any response is charged its estimated input", async () => {
  const d = deps();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const body = { model: "claude-opus-5", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "x".repeat(3000) }] };
  const r = await call(d, "claude", "/v1/messages", { body, headers: { "x-test": "slow-sse" }, signal: ac.signal });
  assert.equal(r.status, 502);
  const [entry] = await logEntries(d.meter);
  assert.equal(entry.allowed, true);
  close(entry.costUsd, (Math.ceil(JSON.stringify(body).length / 3) * 5) / 1e6);
  assert.equal(entry.estimated, true);
  assert.match(entry.reason!, /client disconnected/);
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(lastSeen().aborted, true, "the provider request was stopped");
});

test("disconnect: a non-streamed call keeps running after the client leaves and is charged its real usage", async () => {
  const d = deps();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 1000 }, headers: { "x-test": "slow-json" }, signal: ac.signal, read: false });
  assert.equal(r.status, 200);
  const [entry] = await logEntries(d.meter);
  close(entry.costUsd, (1000 * 5 + 100 * 25) / 1e6);
  assert.equal(entry.estimated, false);
  assert.equal(lastSeen().aborted, false);
});

test("charging does not wait for the client to read the body", async () => {
  const d = deps();
  const r = await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 1000 }, read: false });
  assert.equal(r.status, 200);
  const [entry] = await logEntries(d.meter);
  close(entry.costUsd, (1000 * 5 + 100 * 25) / 1e6);
  await r.res.body?.cancel();
});

// --- Headers and bodies ------------------------------------------------------------------------

test("headers: account details are stripped and redirects to the provider go through the relay", async () => {
  const d = deps();
  const r = await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 10 } });
  assert.equal(r.res.headers.get("anthropic-organization-id"), null);
  assert.equal(r.res.headers.get("request-id"), "req_1");

  const moved = await call(d, "claude", "/v1/models/redirect");
  assert.equal(moved.status, 301);
  assert.equal(moved.res.headers.get("location"), "/api/relay/claude/v1/models/new?x=1");
  assert.equal(moved.res.headers.get("x-echo"), "key [redacted]");
  const away = await call(d, "claude", "/v1/models/elsewhere");
  assert.equal(away.res.headers.get("location"), "https://cdn.example.com/file");
});

test("bodies: a chunked upload past the limit is cut off with 413, without buffering it all", async () => {
  const d = deps();
  let sent = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 64) return controller.close();
      sent++;
      controller.enqueue(chunk);
    },
  });
  const r = await call(d, "claude", "/v1/messages", { raw: stream });
  assert.equal(r.status, 413);
  assert.ok(sent < 40, `read ${sent} MB before stopping`);
  const mock = await call(d, "mock", "/v1/messages", { raw: "x".repeat(2 * 1024 * 1024) });
  assert.equal(mock.status, 413);
});

// --- Log and tokens -------------------------------------------------------------------------------

test("log: requests from callers who don't own a name are counted, not logged", async () => {
  const d = deps();
  assert.equal((await call(d, "claude", "/v1/messages", { kr: "", headers: { "x-api-key": "" } })).status, 401);
  assert.equal((await call(d, "claude", "/v1/messages", { kr: "kr1.bad.0x00" })).status, 401);
  assert.equal((await call(d, "claude", "/v1/messages", { kr: await token(stranger) })).status, 401);
  assert.equal((await call(d, "fax", "/v1")).status, 404);
  assert.deepEqual(d.meter.recent(10), []);
  assert.equal(d.meter.rejectedCount, 4);
});

test("failure budget: a client with many refused requests is slowed down; a known agent is not", async () => {
  const d = deps();
  d.limits = { ...createLimits(), failures: new ClientLimit([2, 0], [100, 0]) };
  assert.equal((await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 10 } })).status, 200);
  const forged = await token(stranger);
  assert.equal((await call(d, "claude", "/v1/messages", { kr: forged })).status, 401);
  assert.equal((await call(d, "claude", "/v1/messages", { kr: forged })).status, 401);
  assert.equal((await call(d, "claude", "/v1/messages", { kr: forged })).status, 429);
  assert.equal((await call(d, "claude", "/v1/messages", { body: { model: "claude-opus-5", max_tokens: 10 } })).status, 200);
});

test("tokens: lifetime, audience and relay.nbf", async () => {
  const d = deps();
  const body = { model: "claude-opus-5", max_tokens: 10 };
  const long = await call(d, "claude", "/v1/messages", { body, kr: await token(agent, { ttl: 25 * 3600 }) });
  assert.equal(long.status, 401);
  assert.match(long.reason!, /lifetime is longer/);
  const elsewhere = await call(d, "claude", "/v1/messages", { body, kr: await token(agent, { aud: "https://evil.example" }) });
  assert.equal(elsewhere.status, 401);
  assert.match(elsewhere.reason!, /not this relay/);
  assert.equal((await call(d, "claude", "/v1/messages", { body, kr: await token(agent, { aud: "http://localhost:3000" }) })).status, 200);
  assert.equal((await call(d, "claude", "/v1/messages", { body, kr: await token(agent, { aud: "http://127.0.0.1:3000" }) })).status, 200);

  const revoked = deps({ leafExtra: { nbf: nowSec() - 60 } });
  const old = await call(revoked, "claude", "/v1/messages", { body, kr: await token(agent, { iat: nowSec() - 120 }) });
  assert.equal(old.status, 401);
  assert.match(old.reason!, /relay\.nbf/);
  assert.equal((await call(revoked, "claude", "/v1/messages", { body })).status, 200);
});

// --- Meter and root --------------------------------------------------------------------------------

test("meter: when spend can't be read, metered calls are refused and unmetered ones still work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-enf-"));
  fs.writeFileSync(path.join(dir, "relay.json"), "");
  const d = deps({ meter: new Meter(path.join(dir, "relay.json"), 5) });
  const r = await call(d, "mock", "/v1/messages", { body: {} });
  assert.equal(r.status, 503);
  assert.match(r.reason!, /damaged/);
  assert.equal((await call(d, "github", "/user")).status, 200);
});

test("root: a root held by someone other than RELAY_ROOT_OWNER refuses every call", async () => {
  const pinned = deps({ env: { RELAY_ROOT_OWNER: stranger.address } });
  assert.equal((await call(pinned, "mock", "/v1/messages", { body: {} })).status, 200);
  const moved = deps({ env: { RELAY_ROOT_OWNER: agent.address } });
  const r = await call(moved, "mock", "/v1/messages", { body: {} });
  assert.equal(r.status, 503);
  assert.match(r.reason!, /RELAY_ROOT_OWNER/);
  const bad = deps({ env: { RELAY_ROOT_OWNER: "not-an-address" } });
  assert.equal((await call(bad, "mock", "/v1/messages", { body: {} })).status, 403);
});

// --- GitHub and Railway ------------------------------------------------------------------------------

test("github: reads and repo work are forwarded; credential, access and workflow writes are refused", async () => {
  const d = deps();
  assert.equal((await call(d, "github", "/user")).status, 200);
  assert.equal(lastSeen().headers.authorization, `Bearer ${GITHUB_KEY}`);
  assert.equal((await call(d, "github", "/repos/acme/app/issues", { body: { title: "bug" } })).status, 200);
  for (const [method, p, body] of [
    ["POST", "/user/keys", { key: "ssh-ed25519 AAAA" }],
    ["POST", "/repos/acme/app/keys", { key: "ssh-ed25519 AAAA" }],
    ["PUT", "/repos/acme/app/collaborators/mallory", {}],
    ["POST", "/orgs/acme/invitations", { invitee_id: 1 }],
    ["PUT", "/repos/acme/app/contents/.github/workflows/x.yml", { content: "" }],
    ["PUT", "/repos/acme/app/actions/secrets/X", {}],
    ["PATCH", "/repos/acme/app", { private: false }],
    ["POST", "/repos/acme/app/git/trees", { tree: [{ path: ".github/workflows/x.yml", mode: "100644", type: "blob", content: "on: push" }] }],
    ["POST", "/graphql", { query: "mutation { addDeployKey(input: {}) { clientMutationId } }" }],
    ["POST", "/graphql", { query: "mutation M { a: createPullRequest(input: {}) { pullRequest { id } } ...F }" }],
  ] as const) {
    const r = await call(d, "github", p, { method, body });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  assert.equal((await call(d, "github", "/graphql", { body: { query: "{ viewer { login } }" } })).status, 404, "queries are forwarded");
  assert.equal(
    (await call(d, "github", "/graphql", { body: { query: "mutation($i: CreatePullRequestInput!) { createPullRequest(input: $i) { pullRequest { id } } }" } })).status,
    404,
  );
  assert.ok(d.meter.recent(50).some((e) => !e.allowed && /\/user\/keys/.test(e.path)), "refusals are in the log");
});

test("railway: queries and deploys are forwarded; token and member mutations are refused", async () => {
  const d = deps();
  assert.equal((await call(d, "railway", "/graphql/v2", { body: { query: "{ me { name } }" } })).status, 200);
  assert.equal((await call(d, "railway", "/graphql/v2", { body: { query: 'mutation { deploymentRedeploy(id: "d1") { id } }' } })).status, 200);
  for (const query of ["mutation { apiTokenCreate(input: {name: \"x\"}) }", "mutation { projectTokenCreate(input: {}) }", "mutation { teamUserInvite(teamId: \"t\") }"]) {
    const r = await call(d, "railway", "/graphql/v2", { body: { query } });
    assert.equal(r.status, 403, query);
  }
  assert.equal((await call(d, "railway", "/graphql/v2", { body: { extensions: { persistedQuery: { sha256Hash: "abc" } } } })).status, 403);
  assert.equal((await call(d, "railway", "/other", { body: {} })).status, 403);
});
