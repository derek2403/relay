// OpenAI-style URLs (/v1/<api>/<path>): the pure mapper for every row of the table, and full calls
// through handleV1Request to a local fake upstream (same token check, route rules, metering and
// signals as /api/relay).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { PROVIDER_IDS } from "./catalog";
import { upstreamEnvName } from "./config";
import { decide } from "./policy";
import type { RelayDeps } from "./providers";
import { MemoryChain, bundle, fakeUpstream, level, makeDeps, tokenFor, waitForLog } from "./testkit";
import { handleV1Request, mapV1Path, v1RelayUrl, v1Segments } from "./v1-routes";

// --- The mapper ------------------------------------------------------------------------------

const map = (path: string, search = "") => mapV1Path(v1Segments(path)!, search);

test("map: /v1/openai is codex, /v1/openai/images is openai-images, both under the upstream's /v1", () => {
  assert.deepEqual(map("/v1/openai/chat/completions"), { provider: "codex", path: "/v1/chat/completions", search: "" });
  assert.deepEqual(map("/v1/openai/responses"), { provider: "codex", path: "/v1/responses", search: "" });
  assert.deepEqual(map("/v1/openai/embeddings"), { provider: "codex", path: "/v1/embeddings", search: "" });
  assert.deepEqual(map("/v1/openai/models"), { provider: "codex", path: "/v1/models", search: "" });
  assert.deepEqual(map("/v1/openai/models/gpt-5"), { provider: "codex", path: "/v1/models/gpt-5", search: "" });
  assert.deepEqual(map("/v1/openai/images/generations"), { provider: "openai-images", path: "/v1/images/generations", search: "" });
  assert.deepEqual(map("/v1/openai/images/edits"), { provider: "openai-images", path: "/v1/images/edits", search: "" });
  assert.deepEqual(map("/v1/openai/images"), { provider: "openai-images", path: "/v1/images", search: "" });
  assert.deepEqual(map("/v1/openai"), { provider: "codex", path: "/v1", search: "" });
  assert.deepEqual(map("/v1/openai/"), { provider: "codex", path: "/v1/", search: "" });
  assert.deepEqual(map("/v1/openai/chat/images"), { provider: "codex", path: "/v1/chat/images", search: "" }, "only a first segment 'images' is image generation");
});

test("map: /v1/anthropic is claude under /v1", () => {
  assert.deepEqual(map("/v1/anthropic/messages"), { provider: "claude", path: "/v1/messages", search: "" });
  assert.deepEqual(map("/v1/anthropic/messages/count_tokens"), { provider: "claude", path: "/v1/messages/count_tokens", search: "" });
});

test("map: /v1/weather is OpenWeatherMap with its own paths and the query kept (no alias, no /v1 added)", () => {
  assert.deepEqual(map("/v1/weather/data/2.5/weather", "?q=Tokyo&units=metric"), { provider: "weather", path: "/data/2.5/weather", search: "?q=Tokyo&units=metric" });
  assert.deepEqual(map("/v1/weather/data/2.5/forecast", "?q=London,GB&units=metric"), { provider: "weather", path: "/data/2.5/forecast", search: "?q=London,GB&units=metric" });
  assert.deepEqual(map("/v1/weather/geo/1.0/direct", "?q=Tokyo&limit=1"), { provider: "weather", path: "/geo/1.0/direct", search: "?q=Tokyo&limit=1" });
  // The query is passed as it is; the relay drops a client's appid later (upstreamSearch).
  assert.deepEqual(map("/v1/weather/data/2.5/weather", "?q=Tokyo&appid=x"), { provider: "weather", path: "/data/2.5/weather", search: "?q=Tokyo&appid=x" });
});

test("map: after an alias one leading v1 is dropped (the Anthropic SDK adds its own /v1)", () => {
  assert.deepEqual(map("/v1/anthropic/v1/messages"), { provider: "claude", path: "/v1/messages", search: "" });
  assert.deepEqual(map("/v1/openai/v1/chat/completions"), { provider: "codex", path: "/v1/chat/completions", search: "" });
  assert.deepEqual(map("/v1/openai/v1/images/generations"), { provider: "openai-images", path: "/v1/images/generations", search: "" });
  assert.deepEqual(map("/v1/anthropic/v1/v1/messages"), { provider: "claude", path: "/v1/v1/messages", search: "" }, "only one");
  assert.deepEqual(map("/v1/openai/v1"), { provider: "codex", path: "/v1", search: "" });
});

test("map: any other catalog id is that provider with the path as it is", () => {
  assert.deepEqual(map("/v1/codex/v1/responses"), { provider: "codex", path: "/v1/responses", search: "" });
  assert.deepEqual(map("/v1/claude/v1/messages"), { provider: "claude", path: "/v1/messages", search: "" });
  assert.deepEqual(map("/v1/openai-images/v1/images/generations"), { provider: "openai-images", path: "/v1/images/generations", search: "" });
  assert.deepEqual(map("/v1/github/repos/acme/app/issues", "?state=open&per_page=5"), { provider: "github", path: "/repos/acme/app/issues", search: "?state=open&per_page=5" });
  assert.deepEqual(map("/v1/gemini/v1beta/models/gemini-2.5-flash:generateContent", "?alt=sse"), {
    provider: "gemini",
    path: "/v1beta/models/gemini-2.5-flash:generateContent",
    search: "?alt=sse",
  });
  assert.deepEqual(map("/v1/slack/chat.postMessage"), { provider: "slack", path: "/chat.postMessage", search: "" });
  assert.deepEqual(map("/v1/mock/"), { provider: "mock", path: "/", search: "" });
  // Every catalog id maps to itself with the path unchanged (weather included: no leading v1 is dropped).
  for (const id of PROVIDER_IDS) assert.deepEqual(map(`/v1/${id}/x`), { provider: id, path: "/x", search: "" }, id);
  assert.deepEqual(map("/v1/weather/v1/forecast"), { provider: "weather", path: "/v1/forecast", search: "" });
});

test("map: segments stay percent-encoded; the relay validates them after the token", () => {
  assert.deepEqual(map("/v1/openai/models/ft%3Agpt-4o%3Aacme"), { provider: "codex", path: "/v1/models/ft%3Agpt-4o%3Aacme", search: "" });
  assert.deepEqual(map("/v1/github/repos/acme/app/contents/docs%2Fa.md"), { provider: "github", path: "/repos/acme/app/contents/docs%2Fa.md", search: "" });
  assert.deepEqual(map("/v1/openai/%69mages/generations"), { provider: "codex", path: "/v1/%69mages/generations", search: "" }, "an encoded alias segment is not the alias");
  assert.deepEqual(map("/v1/openai//models"), { provider: "codex", path: "/v1//models", search: "" }, "the relay refuses the empty segment");
});

test("map: unknown or missing providers are null", () => {
  for (const path of ["/v1/nope/x", "/v1/OpenAI/models", "/v1/%6Fpenai/models", "/v1//openai/models", "/v1/constructor/x", "/v1/__proto__/x", "/v1/", "/v1/api/relay"]) {
    assert.equal(map(path), null, path);
  }
  assert.equal(v1Segments("/api/relay/codex/v1/models"), null);
  assert.equal(v1Segments("/v1"), null);
  assert.equal(mapV1Path([]), null);
});

test("relay URL: the mapped /api/relay URL with the query, unless URL parsing would move it", () => {
  const route = map("/v1/weather/data/2.5/weather", "?q=Tokyo&units=metric")!;
  assert.equal(v1RelayUrl("http://127.0.0.1:3000", route), "http://127.0.0.1:3000/api/relay/weather/data/2.5/weather?q=Tokyo&units=metric");
  assert.equal(v1RelayUrl("http://127.0.0.1:3000", map("/v1/openai/models/ft%3Ax")!), "http://127.0.0.1:3000/api/relay/codex/v1/models/ft%3Ax");
  // Dot segments, plain or encoded, would be resolved by the URL parser (another provider, another path).
  for (const path of ["/v1/openai/images/../chat/completions", "/v1/openai/images/%2e%2e/chat/completions", "/v1/openai/images/.%2E/x", "/v1/codex/v1/%2E/models", "/v1/codex/.."]) {
    assert.equal(v1RelayUrl("http://127.0.0.1:3000", map(path)!), null, path);
  }
});

// --- Full calls --------------------------------------------------------------------------------

const OPENAI_KEY = "sk-proj-OPENAI-REAL-v1-0123456789";
const ANTHROPIC_KEY = "sk-ant-ANTHROPIC-REAL-v1-0123456789";
const OPENWEATHER_KEY = "0owm0REAL0v10key0123456789abcdef";

let up: Awaited<ReturnType<typeof fakeUpstream>>;
before(async () => {
  up = await fakeUpstream((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/v1/chat/completions") {
      return json({ id: "c1", object: "chat.completion", model: "gpt-5", choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
    }
    if (path === "/v1/images/generations") return json({ created: 1, data: [{ b64_json: "aGk=" }] });
    if (path === "/v1/messages") {
      return json({ id: "m1", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 3 } });
    }
    if (path === "/v1/models") return json({ object: "list", data: [] });
    if (path === "/data/2.5/weather") {
      return json({ name: "Tokyo", main: { temp: 17.8, feels_like: 19.9, humidity: 70 }, weather: [{ description: "broken clouds" }], wind: { speed: 3.1 }, clouds: { all: 75 } });
    }
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  });
});
after(() => up.close());

const agent = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
const LEAF = "bot.acme.eth";
const KEYS = "codex,openai-images,claude,weather,mock";

function deps(maxes: Record<string, number> = { "openai-images": 5 }): RelayDeps {
  const chain = new MemoryChain([level("acme.eth", admin.address, bundle(PROVIDER_IDS.join(","))), level(LEAF, agent.address, bundle(KEYS, { caps: { codex: 5, claude: 5 }, maxes }))]);
  const upstreams = Object.fromEntries(["codex", "openai-images", "claude", "weather"].map((id) => [upstreamEnvName(id as never), up.url]));
  return makeDeps(chain, { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY, OPENWEATHER_API_KEY: OPENWEATHER_KEY, ...upstreams });
}

type V1Init = { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal };

async function v1(d: RelayDeps, path: string, init: V1Init = {}) {
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const res = await handleV1Request(
    new Request(`http://localhost:3000${path}`, {
      method,
      headers: { ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    }),
    d,
  );
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, status: res.status, text, json };
}

test("call: POST /v1/openai/chat/completions reaches OpenAI's /v1/chat/completions with the real key and is charged as codex", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const r = await v1(d, "/v1/openai/chat/completions?trace=1", {
    headers: { authorization: `Bearer ${kr}` },
    body: { model: "gpt-5", messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal((r.json?.choices as { message: { content: string } }[])[0].message.content, "hi");
  const seen = up.last();
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/chat/completions?trace=1");
  assert.equal(seen.headers.authorization, `Bearer ${OPENAI_KEY}`);
  const sent = JSON.parse(seen.body);
  assert.equal(sent.model, "gpt-5");
  assert.ok(sent.max_completion_tokens > 0, "the relay set an output limit, as on /api/relay");

  const [entry] = await waitForLog(d.meter, 1);
  assert.equal(entry.provider, "codex");
  assert.equal(entry.path, "/v1/chat/completions");
  assert.equal(entry.name, LEAF);
  assert.ok(entry.allowed && entry.costUsd! > 0);
});

test("call: a streamed request body (duplex) is forwarded whole", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const text = JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "streamed body" }] });
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const bytes = new TextEncoder().encode(text);
      c.enqueue(bytes.subarray(0, 10));
      c.enqueue(bytes.subarray(10));
      c.close();
    },
  });
  const res = await handleV1Request(
    new Request("http://localhost:3000/v1/openai/chat/completions", { method: "POST", headers: { authorization: `Bearer ${kr}`, "content-type": "application/json" }, body, duplex: "half" } as RequestInit),
    d,
  );
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(JSON.parse(up.last().body).messages[0].content, "streamed body");
});

test("call: /v1/openai/images/generations is OpenAI Images, counted per image", async () => {
  const d = deps({ "openai-images": 1 });
  const kr = await tokenFor(agent, LEAF);
  const r = await v1(d, "/v1/openai/images/generations", { headers: { authorization: `Bearer ${kr}` }, body: { model: "gpt-image-1", prompt: "Tokyo in the rain", n: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(up.last().url, "/v1/images/generations");
  assert.equal(up.last().headers.authorization, `Bearer ${OPENAI_KEY}`);
  const again = await v1(d, "/v1/openai/images/generations", { headers: { authorization: `Bearer ${kr}` }, body: { prompt: "again" } });
  assert.equal(again.status, 403, "the image count cap applies");
  const p = await decide({ name: LEAF, provider: "openai-images" }, d);
  assert.equal(p.levels[1].used?.["openai-images"], 1);
});

test("call: /v1/openai/models is free, /v1/openai/images/... can't reach text endpoints", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const models = await v1(d, "/v1/openai/models", { headers: { authorization: `Bearer ${kr}` } });
  assert.equal(models.status, 200, models.text);
  assert.equal(up.last().url, "/v1/models");
  const denied = await v1(d, "/v1/openai/images/variations", { headers: { authorization: `Bearer ${kr}` }, body: {} });
  assert.equal(denied.status, 403);
  assert.match(String(denied.json?.reason), /doesn't forward POST \/v1\/images\/variations to openai-images/);
});

test("call: /v1/anthropic/v1/messages (the Anthropic SDK's URL) reaches Claude's /v1/messages with x-api-key", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const r = await v1(d, "/v1/anthropic/v1/messages", { headers: { "x-api-key": kr, "anthropic-version": "2023-06-01" }, body: { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hi" }] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(up.last().url, "/v1/messages");
  assert.equal(up.last().headers["x-api-key"], ANTHROPIC_KEY);
});

test("call: GET /v1/weather/data/2.5/weather reaches OpenWeatherMap's /data/2.5/weather with the query and the relay's appid; POST is refused", async () => {
  const d = deps({ weather: 2 });
  const kr = await tokenFor(agent, LEAF);
  const query = "?q=Tokyo&units=metric";
  const r = await v1(d, `/v1/weather/data/2.5/weather${query}`, { headers: { authorization: `Bearer ${kr}` } });
  assert.equal(r.status, 200, r.text);
  assert.equal((r.json?.main as { temp: number }).temp, 17.8);
  assert.equal(up.last().method, "GET");
  assert.equal(up.last().url, `/data/2.5/weather${query}&appid=${OPENWEATHER_KEY}`);
  assert.equal(up.last().headers.authorization, undefined, "the kr1 token never reaches OpenWeatherMap");
  assert.ok(!JSON.stringify(up.last()).includes(kr));
  assert.ok(!r.text.includes(OPENWEATHER_KEY), "the key never comes back");

  const seen = up.seen.length;
  const post = await v1(d, "/v1/weather/data/2.5/weather", { headers: { authorization: `Bearer ${kr}` }, body: {} });
  assert.equal(post.status, 403);
  assert.match(String(post.json?.reason), /doesn't forward POST \/data\/2\.5\/weather to weather/);
  assert.equal(up.seen.length, seen);

  // A client's own appid is dropped: the relay's key is the only one sent.
  assert.equal((await v1(d, `/v1/weather/data/2.5/weather${query}&appid=${kr}`, { headers: { authorization: `Bearer ${kr}` } })).status, 200);
  assert.equal(up.last().url, `/data/2.5/weather${query}&appid=${OPENWEATHER_KEY}`);
  const over = await v1(d, `/v1/weather/data/2.5/weather${query}`, { headers: { authorization: `Bearer ${kr}` } });
  assert.equal(over.status, 403, "relay.max.weather = 2");
  assert.equal(up.seen.length, seen + 1, "the capped call was never sent");
});

test("call: /v1/weather without OPENWEATHER_API_KEY on the relay is 503 provider not configured", async () => {
  const chain = new MemoryChain([level("acme.eth", admin.address, bundle(PROVIDER_IDS.join(","))), level(LEAF, agent.address, bundle(KEYS))]);
  const d = makeDeps(chain, { RELAY_UPSTREAM_WEATHER: up.url });
  const kr = await tokenFor(agent, LEAF);
  const seen = up.seen.length;
  const r = await v1(d, "/v1/weather/data/2.5/weather?q=Tokyo&units=metric", { headers: { authorization: `Bearer ${kr}` } });
  assert.equal(r.status, 503);
  assert.equal(r.json?.error, "provider not configured");
  assert.match(String(r.json?.reason), /OPENWEATHER_API_KEY/);
  assert.equal(up.seen.length, seen);
});

test("call: /v1/mock answers like /api/relay/mock", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const r = await v1(d, "/v1/mock/v1/messages", { headers: { "x-api-key": kr }, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json?.model, "mock");
});

test("call: no token is 401 JSON, an unknown API is 404 JSON (counted as rejected)", async () => {
  const d = deps();
  const noToken = await v1(d, "/v1/openai/models");
  assert.equal(noToken.status, 401);
  assert.equal(noToken.json?.error, "missing token");
  assert.equal((await v1(d, "/v1/weather/data/2.5/weather?q=Tokyo")).status, 401);

  const before = d.meter.rejectedCount;
  const unknown = await v1(d, "/v1/nope/chat/completions");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.res.headers.get("content-type"), "application/json");
  assert.equal(unknown.json?.error, "unknown provider");
  assert.match(String(unknown.json?.reason), /"nope" is not an API this relay serves\. Use \/v1\/openai/);
  assert.equal(d.meter.rejectedCount, before + 1);
  assert.equal(up.seen.filter((s) => s.url.includes("nope")).length, 0);
});

test("call: the client's abort signal reaches the relay (a GET is stopped when the client leaves)", async () => {
  const d = deps();
  const upstream: { signal: AbortSignal | null } = { signal: null };
  d.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      upstream.signal = init!.signal!;
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    })) as typeof fetch;
  const kr = await tokenFor(agent, LEAF);
  const client = new AbortController();
  const pending = handleV1Request(new Request("http://localhost:3000/v1/weather/data/2.5/weather?q=Tokyo", { headers: { authorization: `Bearer ${kr}` }, signal: client.signal }), d);
  // Stop waiting if the relay answers without calling the upstream (a refusal), instead of hanging.
  let answered = false;
  pending.then(() => (answered = true), () => (answered = true));
  while (!upstream.signal && !answered) await new Promise((r) => setTimeout(r, 5));
  assert.ok(upstream.signal, "the call reached the upstream");
  client.abort();
  const res = await pending;
  assert.equal(res.status, 502);
  assert.ok(upstream.signal.aborted);
  const [entry] = await waitForLog(d.meter, 1);
  assert.match(entry.reason ?? "", /client disconnected/);
});
