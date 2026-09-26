import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { namehash } from "../ens/names";
import { RECORD_KEYS, parseBundle } from "./bundle";
import { loadConfig } from "./config";
import type { ChainLevel, ChainReader } from "./ens";
import { Meter, spendKey } from "./meter";
import {
  PROVIDER_SPECS,
  PathError,
  type RelayDeps,
  buildUpstreamUrl,
  clientResponseHeaders,
  createRedactor,
  handleRelayRequest,
  relayPathFromUrl,
  upstreamRequestHeaders,
} from "./providers";
import { createToken } from "./token";
import type { LogEntry } from "./types";

const REAL_KEY = "sk-ant-api03-REAL-KEY-never-leak-0123456789";
const REAL_OPENAI = "sk-proj-REAL-OPENAI-KEY-0123456789";

// --- Path validation ----------------------------------------------------------------

test("buildUpstreamUrl keeps the provider origin and the query string", () => {
  const b = "https://api.anthropic.com";
  assert.equal(buildUpstreamUrl(b, "/v1/messages", "?beta=true").href, "https://api.anthropic.com/v1/messages?beta=true");
  assert.equal(buildUpstreamUrl(b, "").href, "https://api.anthropic.com/");
  assert.equal(buildUpstreamUrl(b, "/v1/models/").href, "https://api.anthropic.com/v1/models/");
  assert.equal(buildUpstreamUrl(b, "/v1/files/a%20b:c@d").href, "https://api.anthropic.com/v1/files/a%20b:c@d");
  assert.equal(buildUpstreamUrl("https://backboard.railway.com/graphql", "/v2").href, "https://backboard.railway.com/graphql/v2");
  assert.equal(buildUpstreamUrl("http://127.0.0.1:9999", "/@evil.com").origin, "http://127.0.0.1:9999");
});

test("buildUpstreamUrl rejects paths that could leave the provider", () => {
  const b = "https://api.github.com";
  for (const bad of [
    "//evil.com/x",
    "/v1//x",
    "/v1/../../x",
    "/v1/./x",
    "/v1/%2e%2e/x",
    "/v1/%2E%2e",
    "/v1/..%2F..%2Fx",
    "/v1/%2F%2Fevil.com",
    "/https:%2F%2Fevil.com",
    "/v1/a%5Cb",
    "/v1/a\\b",
    "/v1/%252e%252e",
    "/v1/%00",
    "/v1/%zz",
    "/v1/a%3Fb",
    "/v1/a b",
    "v1/no-leading-slash",
  ]) {
    assert.throws(() => buildUpstreamUrl(b, bad), PathError, bad);
  }
});

test("relayPathFromUrl takes the raw path after /api/relay/<provider>", () => {
  assert.equal(relayPathFromUrl(new URL("http://x/api/relay/claude/v1/messages?x=1"), "claude"), "/v1/messages");
  assert.equal(relayPathFromUrl(new URL("http://x/api/relay/claude"), "claude"), "");
  // URL parsing already collapses dot segments, which then fall outside the prefix.
  assert.throws(() => relayPathFromUrl(new URL("http://x/api/relay/claude/../../etc/passwd"), "claude"), PathError);
  assert.throws(() => relayPathFromUrl(new URL("http://x/api/relay/claudex/v1"), "claude"), PathError);
});

// --- Header hygiene -----------------------------------------------------------------

test("upstream headers: client credentials and hop-by-hop headers dropped, real key injected", () => {
  const incoming = new Headers({
    authorization: "Bearer kr1.token.0xsig",
    "x-api-key": "kr1.token.0xsig",
    cookie: "session=1",
    host: "localhost:3000",
    "content-length": "12",
    connection: "keep-alive, x-custom-hop",
    "x-custom-hop": "1",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    upgrade: "h2c",
    "proxy-authorization": "Basic abc",
    "accept-encoding": "gzip, br",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "prompt-caching-2024-07-31",
    "openai-beta": "assistants=v2",
    "content-type": "application/json",
    "x-stainless-lang": "js",
  });

  const claude = upstreamRequestHeaders(incoming, PROVIDER_SPECS.claude, REAL_KEY);
  assert.equal(claude.get("x-api-key"), REAL_KEY);
  assert.equal(claude.get("authorization"), null);
  for (const h of ["cookie", "host", "content-length", "connection", "x-custom-hop", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization"]) {
    assert.equal(claude.get(h), null, h);
  }
  assert.equal(claude.get("accept-encoding"), "identity");
  assert.equal(claude.get("anthropic-version"), "2023-06-01");
  assert.equal(claude.get("anthropic-beta"), "prompt-caching-2024-07-31");
  assert.equal(claude.get("openai-beta"), "assistants=v2");
  assert.equal(claude.get("content-type"), "application/json");
  assert.equal(claude.get("x-stainless-lang"), "js");

  const codex = upstreamRequestHeaders(incoming, PROVIDER_SPECS.codex, REAL_OPENAI);
  assert.equal(codex.get("authorization"), `Bearer ${REAL_OPENAI}`);
  assert.equal(codex.get("x-api-key"), null);

  const github = upstreamRequestHeaders(new Headers({ authorization: "Bearer kr1.a.0x0" }), PROVIDER_SPECS.github, "ghp_real");
  assert.equal(github.get("authorization"), "Bearer ghp_real");
  assert.equal(github.get("user-agent"), "keyless-relay");
  assert.equal(upstreamRequestHeaders(new Headers({ "user-agent": "gh/2" }), PROVIDER_SPECS.github, "ghp_real").get("user-agent"), "gh/2");

  assert.equal(upstreamRequestHeaders(new Headers(), PROVIDER_SPECS.railway, "rw_real").get("authorization"), "Bearer rw_real");
  assert.equal(upstreamRequestHeaders(new Headers(), PROVIDER_SPECS.claude, REAL_KEY).get("anthropic-version"), "2023-06-01");
});

test("client response headers: framing, encoding and cookies dropped", () => {
  const out = clientResponseHeaders(
    new Headers({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": "100",
      "transfer-encoding": "chunked",
      connection: "close",
      "set-cookie": "cf=1",
      "request-id": "req_1",
      "anthropic-ratelimit-requests-remaining": "99",
    }),
  );
  assert.deepEqual([...out.keys()].sort(), ["anthropic-ratelimit-requests-remaining", "content-type", "request-id"]);
});

test("redactor removes the key even when split across chunks", () => {
  const r = createRedactor(REAL_KEY);
  const text = `{"echo":"${REAL_KEY}","again":"${REAL_KEY}"}`;
  const bytes = Buffer.from(text);
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 5) out.push(Buffer.from(r.push(bytes.subarray(i, i + 5))));
  out.push(Buffer.from(r.end()));
  const joined = Buffer.concat(out).toString();
  assert.equal(joined, '{"echo":"[redacted]","again":"[redacted]"}');
  // A tail that only looks like the start of a key is released at the end.
  const r2 = createRedactor(REAL_KEY);
  assert.equal(Buffer.from(r2.push(Buffer.from("data: sk-an"))).toString(), "data: ");
  assert.equal(Buffer.from(r2.end()).toString(), "sk-an");
});

// --- Forwarding against a local fake upstream -----------------------------------------

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

let server: http.Server;
let upstreamUrl = "";
const seen: Seen[] = [];
let releaseStream: () => void = () => {};
let streamClosed: Promise<void> = Promise.resolve();

const sseEvent = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const FIRST = sseEvent("message_start", {
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 1000, output_tokens: 1 } },
});
const DELTA = sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello world!" } });
const REST =
  sseEvent("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } }) +
  sseEvent("message_stop", { type: "message_stop" });

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "text/event-stream", "set-cookie": "upstream=1", "request-id": "req_fake" });
        res.write(FIRST);
        res.write(DELTA);
        // Hold the rest until the test has seen the first bytes: proves the relay streams.
        let resolveClosed: () => void;
        streamClosed = new Promise((r) => (resolveClosed = r));
        res.on("close", () => resolveClosed());
        new Promise<void>((r) => (releaseStream = r)).then(() => res.end(REST));
      } else if (req.url === "/v1/models/leaky") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `invalid x-api-key ${req.headers["x-api-key"]}` }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const LEAF = "laptop.derek.acme.eth";

const bundle = (keys: string, caps: Record<string, number> = {}) =>
  parseBundle({ [RECORD_KEYS.keys]: keys, ...Object.fromEntries(Object.entries(caps).map(([p, v]) => [RECORD_KEYS.cap(p), String(v)])) });

function level(name: string, owner: Address, b: ReturnType<typeof bundle>): ChainLevel {
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
    checks: { registryVerified: true, resolverVerified: true, canonical: true },
  };
}

class FakeReader implements ChainReader {
  constructor(private readonly levels: ChainLevel[]) {}
  async readLevels(_root: string, name: string) {
    return this.levels.filter((l) => name === l.name || name.endsWith(`.${l.name}`));
  }
}

function makeDeps(env: Record<string, string> = {}, leafBundle = bundle("claude,codex,mock", { claude: 10 }), middleBundle = bundle("claude,mock")): RelayDeps {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fwd-"));
  return {
    config: loadConfig({
      RELAY_ROOT_NAME: "acme.eth",
      RELAY_DATA_DIR: dir,
      ANTHROPIC_API_KEY: REAL_KEY,
      RELAY_UPSTREAM_CLAUDE: upstreamUrl,
      ...env,
    }),
    reader: new FakeReader([
      level("acme.eth", stranger.address, bundle("claude,codex,mock", { claude: 100 })),
      level("derek.acme.eth", stranger.address, middleBundle),
      level(LEAF, agent.address, leafBundle),
    ]),
    meter: new Meter(path.join(dir, "relay.json"), 5),
  };
}

async function token(signer = agent, name = LEAF, ttl = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return createToken(signer, { name, iat: now, exp: now + ttl });
}

async function waitForLog(meter: Meter, n = 1): Promise<LogEntry[]> {
  for (let i = 0; i < 200; i++) {
    const entries = meter.recent(10);
    if (entries.length >= n) return entries;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("no log entry");
}

const decoder = new TextDecoder();

test("forwarding: streams SSE through unchanged, strips client auth, injects the key, meters the body", async () => {
  const deps = makeDeps();
  const kr = await token();
  const res = await handleRelayRequest(
    new Request(`http://localhost:3000/api/relay/claude/v1/messages?beta=true`, {
      method: "POST",
      headers: {
        "x-api-key": kr,
        authorization: `Bearer ${kr}`,
        cookie: "sid=1",
        "accept-encoding": "gzip",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }),
    }),
    "claude",
    deps,
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("request-id"), "req_fake");

  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("Hello world!")) {
    const { value, done } = await reader.read();
    assert.ok(!done, "stream ended before the first events");
    text += decoder.decode(value, { stream: true });
  }
  // The upstream is still holding the rest: what we have arrived by streaming.
  assert.equal(text, FIRST + DELTA);
  assert.equal(deps.meter.recent(10).length, 0, "not charged before the body ends");

  releaseStream();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.equal(text, FIRST + DELTA + REST);
  assert.ok(!text.includes(REAL_KEY));

  const up = seen[seen.length - 1];
  assert.equal(up.method, "POST");
  assert.equal(up.url, "/v1/messages?beta=true");
  assert.equal(up.headers["x-api-key"], REAL_KEY);
  assert.equal(up.headers.authorization, undefined);
  assert.equal(up.headers.cookie, undefined);
  assert.equal(up.headers["accept-encoding"], "identity");
  assert.equal(up.headers["anthropic-version"], "2023-06-01");
  assert.equal(up.headers["anthropic-beta"], "fine-grained-tool-streaming-2025-05-14");
  assert.equal(JSON.parse(up.body).model, "claude-sonnet-4-6");

  const [entry] = await waitForLog(deps.meter);
  const expected = (1000 * 3 + 500 * 15) / 1e6;
  assert.equal(entry.allowed, true);
  assert.equal(entry.status, 200);
  assert.equal(entry.estimated, false);
  assert.equal(entry.name, LEAF);
  assert.equal(entry.signer, agent.address);
  assert.ok(Math.abs(entry.costUsd! - expected) < 1e-12);
  for (const name of ["acme.eth", "derek.acme.eth", LEAF]) {
    assert.ok(Math.abs(deps.meter.spent(spendKey(namehash(name), "7", "claude", new Date().toISOString().slice(0, 7))) - expected) < 1e-12, name);
  }
  assert.ok(!JSON.stringify(deps.meter.recent(10)).includes(REAL_KEY));
});

test("forwarding: a client that disconnects mid-stream is charged an estimate", async () => {
  const deps = makeDeps();
  const res = await handleRelayRequest(
    new Request(`http://localhost:3000/api/relay/claude/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": await token(), "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", stream: true }),
    }),
    "claude",
    deps,
  );
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("Hello world!")) text += decoder.decode((await reader.read()).value, { stream: true });
  await reader.cancel("client went away");
  await streamClosed; // the upstream connection is torn down too

  const [entry] = await waitForLog(deps.meter);
  assert.equal(entry.estimated, true);
  assert.equal(entry.reason, "client disconnected");
  // 1000 input tokens seen + ceil(12 chars / 4) = 3 output tokens.
  assert.ok(Math.abs(entry.costUsd! - (1000 * 3 + 3 * 15) / 1e6) < 1e-12, String(entry.costUsd));
  releaseStream();
});

test("forwarding: a key echoed by the upstream is redacted from the response", async () => {
  const deps = makeDeps();
  const res = await handleRelayRequest(
    new Request(`http://localhost:3000/api/relay/claude/v1/models/leaky`, { headers: { "x-api-key": await token() } }),
    "claude",
    deps,
  );
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.ok(!body.includes(REAL_KEY));
  assert.match(body, /\[redacted\]/);
  const [entry] = await waitForLog(deps.meter);
  assert.equal(entry.costUsd, 0);
});

test("mock provider: answers itself with an Anthropic-shaped message and charges exactly $0.01", async () => {
  const deps = makeDeps();
  const res = await handleRelayRequest(
    new Request("http://localhost:3000/api/relay/mock/v1/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "anything", messages: [] }),
    }),
    "mock",
    deps,
  );
  assert.equal(res.status, 200);
  const msg = await res.json();
  assert.equal(msg.type, "message");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.model, "mock");
  assert.deepEqual(msg.content, [{ type: "text", text: `Hello from the relay, ${LEAF}` }]);
  assert.equal(msg.stop_reason, "end_turn");
  assert.deepEqual(msg.usage, { input_tokens: 10, output_tokens: 20 });
  const [entry] = await waitForLog(deps.meter);
  assert.equal(entry.costUsd, 0.01);
  assert.equal(entry.estimated, false);
  assert.equal(deps.meter.spent(spendKey(namehash("acme.eth"), "7", "mock", new Date().toISOString().slice(0, 7))), 0.01);

  // stream: true gets the same message as server-sent events.
  const streamed = await handleRelayRequest(
    new Request("http://localhost:3000/api/relay/mock/v1/messages", {
      method: "POST",
      headers: { "x-api-key": await token(), "content-type": "application/json" },
      body: JSON.stringify({ stream: true }),
    }),
    "mock",
    deps,
  );
  assert.equal(streamed.headers.get("content-type"), "text/event-stream");
  assert.match(await streamed.text(), /event: message_stop/);
});

test("status codes: 401 token problems and owner mismatch, 403 denial, 404 provider, 503 not configured, 400 path, 502 upstream", async () => {
  const deps = makeDeps();
  const call = async (provider: string, headers: Record<string, string>, p = "/v1/messages", d = deps) => {
    const res = await handleRelayRequest(new Request(`http://localhost:3000/api/relay/${provider}${p}`, { method: "POST", headers, body: "{}" }), provider, d);
    return { status: res.status, body: await res.json() };
  };
  const kr = await token();

  assert.equal((await call("claude", {})).status, 401);
  assert.equal((await call("claude", { "x-api-key": "kr1.bad.0x00" })).status, 401);
  assert.equal((await call("claude", { "x-api-key": await token(agent, LEAF, -10) })).body.error, "token expired");
  const notOwner = await call("claude", { "x-api-key": await token(stranger) });
  assert.equal(notOwner.status, 401);
  assert.match(notOwner.body.reason, /does not own/);
  assert.equal((await call("fax", { "x-api-key": kr })).status, 404);
  // Every level allows codex, but the relay has no OpenAI key.
  const noKey = makeDeps({}, bundle("claude,codex,mock", { claude: 10 }), bundle("claude,codex,mock"));
  assert.equal((await call("codex", { authorization: `Bearer ${kr}` }, "/v1/responses", noKey)).status, 503);
  assert.equal((await call("claude", { "x-api-key": kr }, "/v1/%2e%2e%2Fsecret")).status, 400);

  // derek.acme.eth (a middle level) doesn't list codex -> 403 naming that level (codex configured via a dummy key).
  const denied = await call("codex", { authorization: `Bearer ${kr}` }, "/v1/responses", makeDeps({ OPENAI_API_KEY: REAL_OPENAI }));
  assert.equal(denied.status, 403);
  assert.match(denied.body.reason, /^derek\.acme\.eth does not allow codex/);

  // An exhausted leaf cap -> 403.
  const broke = makeDeps({}, bundle("claude", { claude: 0 }));
  const capped = await call("claude", { "x-api-key": kr }, "/v1/messages", broke);
  assert.equal(capped.status, 403);
  assert.match(capped.body.reason, /has used its claude cap/);

  const down = await call("claude", { "x-api-key": kr }, "/v1/messages", makeDeps({ RELAY_UPSTREAM_CLAUDE: "http://127.0.0.1:1" }));
  assert.equal(down.status, 502);
  assert.ok(!JSON.stringify(down.body).includes(REAL_KEY));

  const log = JSON.stringify(deps.meter.recent(100));
  assert.ok(!log.includes(REAL_KEY) && !log.includes(REAL_OPENAI));
});
