// Catalog-driven forwarding: each auth kind, default headers, upstream
// overrides, the route tables for OpenAI Images, Gemini and weather (OpenWeatherMap, key in ?appid=),
// and the status list.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CATALOG, CATEGORY_LABELS, PROVIDER_IDS, catalogEntry, countUnit } from "./catalog";
import { loadConfig, upstreamEnvName } from "./config";
import { PROVIDER_SPECS, upstreamRequestHeaders, upstreamSearch } from "./providers";
import { allowedRoutesText, routeFor } from "./routes";
import { MemoryChain, bundle, fakeUpstream, level, makeDeps, relayJson, tokenFor, waitForLog } from "./testkit";

const KEYS = {
  OPENAI_API_KEY: "sk-proj-OPENAI-REAL-0123456789",
  GEMINI_API_KEY: "AIza-GEMINI-REAL-0123456789",
  LINEAR_API_KEY: "lin_api_LINEAR-REAL-0123456789",
  NOTION_TOKEN: "ntn_NOTION-REAL-0123456789",
  STRIPE_SECRET_KEY: "sk_test_STRIPE-REAL-0123456789",
  OPENWEATHER_API_KEY: "0owm0REAL0key0123456789abcdef012",
};

let up: Awaited<ReturnType<typeof fakeUpstream>>;
before(async () => {
  up = await fakeUpstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
after(() => up.close());

const agent = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
const LEAF = "bot.acme.eth";
const ALL = PROVIDER_IDS.join(",");

function deps(env: Record<string, string> = {}) {
  const chain = new MemoryChain([level("acme.eth", admin.address, bundle(ALL)), level(LEAF, agent.address, bundle(ALL))]);
  const upstreams = Object.fromEntries(["gemini", "linear", "notion", "stripe", "openai-images", "weather"].map((id) => [upstreamEnvName(id as never), up.url]));
  return makeDeps(chain, { ...KEYS, ...upstreams, ...env });
}

test("catalog: every provider has a spec; codex and openai-images share the OpenAI key", () => {
  assert.deepEqual(Object.keys(PROVIDER_SPECS).sort(), [...PROVIDER_IDS].sort());
  assert.deepEqual(PROVIDER_IDS, ["claude", "codex", "openai-images", "gemini", "github", "railway", "vercel", "linear", "canva", "hubspot", "mailchimp", "stripe", "notion", "slack", "weather", "mock"]);
  const config = loadConfig({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY });
  assert.equal(config.keyFor("codex"), KEYS.OPENAI_API_KEY);
  assert.equal(config.keyFor("openai-images"), KEYS.OPENAI_API_KEY);
  assert.ok(config.isConfigured("openai-images"));
  assert.ok(!config.isConfigured("stripe"), "no key, not configured");
  assert.ok(config.isConfigured("mock"), "the mock needs no key");
  assert.ok(!config.isConfigured("weather"), "OpenWeatherMap needs OPENWEATHER_API_KEY");
  assert.equal(config.keyFor("weather"), null);
  const withWeather = loadConfig({ OPENWEATHER_API_KEY: KEYS.OPENWEATHER_API_KEY });
  assert.ok(withWeather.isConfigured("weather"));
  assert.equal(withWeather.keyFor("weather"), KEYS.OPENWEATHER_API_KEY);
});

test("catalog: weather is OpenWeatherMap with its key in ?appid=, in its own Data category, counted per request", () => {
  const weather = catalogEntry("weather");
  assert.deepEqual(weather, {
    id: "weather",
    label: "Weather (OpenWeatherMap)",
    category: "data",
    keyEnv: "OPENWEATHER_API_KEY",
    upstream: "https://api.openweathermap.org",
    auth: { kind: "query", name: "appid" },
    metering: { kind: "requests" },
    dollarCaps: false,
    note: "Current weather and forecasts by city: /data/2.5/weather?q=Tokyo&units=metric.",
  });
  assert.equal(CATEGORY_LABELS.data, "Data");
  assert.deepEqual(Object.keys(CATEGORY_LABELS), ["ai", "dev", "marketing", "business", "data", "test"]);
  assert.equal(countUnit("weather"), "requests");
  assert.equal(loadConfig({}).upstreams.weather, "https://api.openweathermap.org");
  // The key goes in the query, not a header: the client's token is dropped and no header replaces it.
  const headers = upstreamRequestHeaders(new Headers({ authorization: "Bearer kr1.a.0x0", "x-api-key": "kr1.a.0x0" }), PROVIDER_SPECS.weather, KEYS.OPENWEATHER_API_KEY);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-api-key"), null);
  assert.ok(![...headers.values()].some((v) => v.includes(KEYS.OPENWEATHER_API_KEY)), "no header carries the key");
  // A client's own appid never goes upstream; other parameters (and Gemini's ?key=, which isn't weather's) stay.
  const search = (q: string) => upstreamSearch("weather", new URL(`http://localhost/api/relay/weather/data/2.5/weather${q}`));
  assert.equal(search("?q=Tokyo&appid=kr1.a.0x0&units=metric"), "?q=Tokyo&units=metric");
  assert.equal(search("?appid=theirs&appid=again"), "");
  assert.equal(search("?q=Tokyo&APPID=theirs&AppId=too"), "?q=Tokyo", "in any case");
  assert.equal(search("?q=Tokyo&units=metric"), "?q=Tokyo&units=metric");
  assert.equal(search("?q=Tokyo&key=x"), "?q=Tokyo&key=x");
});

test("upstreams: catalog defaults, RELAY_UPSTREAM_<ID> overrides (dashes become underscores), invalid overrides turn a provider off", () => {
  assert.equal(upstreamEnvName("openai-images"), "RELAY_UPSTREAM_OPENAI_IMAGES");
  const config = loadConfig({
    OPENAI_API_KEY: "x".repeat(20),
    RELAY_UPSTREAM_OPENAI_IMAGES: "http://127.0.0.1:9999/base/",
    RELAY_UPSTREAM_CODEX: "ftp://nope",
  });
  assert.equal(config.upstreams["openai-images"], "http://127.0.0.1:9999/base");
  assert.equal(config.upstreams.slack, "https://slack.com/api");
  assert.equal(config.upstreams.codex, null);
  assert.ok(!config.isConfigured("codex"));
  assert.equal(config.upstreams.mock, null);
});

test("auth kinds: bearer, header and raw Authorization, with default headers only when missing", () => {
  const client = new Headers({ authorization: "Bearer kr1.a.0x0", "x-api-key": "kr1.a.0x0", "x-goog-api-key": "kr1.a.0x0", "user-agent": "tool/1" });
  const stripe = upstreamRequestHeaders(client, PROVIDER_SPECS.stripe, "sk_real");
  assert.equal(stripe.get("authorization"), "Bearer sk_real");
  assert.equal(stripe.get("x-api-key"), null);
  assert.equal(stripe.get("x-goog-api-key"), null, "a client's key header never passes");

  const gemini = upstreamRequestHeaders(client, PROVIDER_SPECS.gemini, "AIza_real");
  assert.equal(gemini.get("x-goog-api-key"), "AIza_real");
  assert.equal(gemini.get("authorization"), null);

  const linear = upstreamRequestHeaders(client, PROVIDER_SPECS.linear, "lin_real");
  assert.equal(linear.get("authorization"), "lin_real", "no Bearer scheme");

  const notion = upstreamRequestHeaders(new Headers(), PROVIDER_SPECS.notion, "ntn_real");
  assert.equal(notion.get("notion-version"), "2022-06-28");
  assert.equal(upstreamRequestHeaders(new Headers({ "notion-version": "2025-09-03" }), PROVIDER_SPECS.notion, "ntn_real").get("notion-version"), "2025-09-03");
  assert.equal(upstreamRequestHeaders(new Headers(), PROVIDER_SPECS.github, "ghp").get("user-agent"), "keyless-relay");
  assert.equal(upstreamRequestHeaders(client, PROVIDER_SPECS.github, "ghp").get("user-agent"), "tool/1");
  assert.equal(upstreamRequestHeaders(new Headers(), PROVIDER_SPECS.claude, "sk-ant").get("anthropic-version"), "2023-06-01");
});

test("routes: OpenAI Images and Gemini only forward what the relay can price; other APIs forward anything", () => {
  assert.deepEqual(routeFor("openai-images", "POST", ["v1", "images", "generations"]), { kind: "images", api: null });
  assert.deepEqual(routeFor("openai-images", "POST", ["v1", "images", "edits"]), { kind: "images", api: null });
  assert.deepEqual(routeFor("openai-images", "GET", ["v1", "models"]), { kind: "free", api: null });
  assert.equal(routeFor("openai-images", "POST", ["v1", "responses"]), null, "text goes through codex");
  assert.deepEqual(routeFor("gemini", "POST", ["v1beta", "models", "gemini-2.5-flash:generateContent"]), { kind: "request", api: null });
  assert.deepEqual(routeFor("gemini", "POST", ["v1", "models", "gemini-2.5-flash:streamGenerateContent"]), { kind: "request", api: null });
  assert.deepEqual(routeFor("gemini", "POST", ["v1beta", "models", "gemini-2.5-flash:countTokens"]), { kind: "request", api: null });
  assert.equal(routeFor("gemini", "POST", ["v1beta", "models", ":generateContent"]), null, "a model name is required");
  assert.equal(routeFor("gemini", "POST", ["v1beta", "cachedContents"]), null);
  assert.deepEqual(routeFor("stripe", "DELETE", ["v1", "customers", "cus_1"]), { kind: "request", api: null });
  assert.deepEqual(routeFor("slack", "POST", ["chat.postMessage"]), { kind: "request", api: null });
});

test("routes: weather forwards GET /data/2.5/<endpoint> and /geo/1.0/<endpoint> only, one request each", () => {
  const request = { kind: "request", api: null };
  assert.deepEqual(routeFor("weather", "GET", ["data", "2.5", "weather"]), request);
  assert.deepEqual(routeFor("weather", "GET", ["data", "2.5", "forecast"]), request);
  assert.deepEqual(routeFor("weather", "GET", ["geo", "1.0", "direct"]), request);
  assert.deepEqual(routeFor("weather", "GET", ["geo", "1.0", "reverse"]), request);
  assert.deepEqual(routeFor("weather", "HEAD", ["data", "2.5", "weather"]), request);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(routeFor("weather", method, ["data", "2.5", "weather"]), null, method);
    assert.equal(routeFor("weather", method, ["geo", "1.0", "direct"]), null, method);
  }
  assert.equal(routeFor("weather", "GET", ["data", "3.0", "onecall"]), null, "One Call 3.0 is a separate subscription");
  assert.equal(routeFor("weather", "GET", ["v1", "forecast"]), null, "Open-Meteo's paths are gone");
  assert.equal(routeFor("weather", "GET", ["data", "2.5"]), null);
  assert.equal(routeFor("weather", "GET", ["data", "2.5", "weather", "x"]), null);
  assert.equal(routeFor("weather", "GET", []), null);
  assert.equal(allowedRoutesText("weather"), "GET /data/2.5/*, GET /geo/1.0/*");
});

test("forwarding: bearer (Stripe), raw Authorization (Linear) and default headers (Notion) reach the upstream; each call counts one", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  assert.equal((await relayJson(d, "stripe", "/v1/customers", { kr, method: "GET" })).status, 200);
  assert.equal(up.last().headers.authorization, `Bearer ${KEYS.STRIPE_SECRET_KEY}`);
  assert.equal(up.last().url, "/v1/customers");

  assert.equal((await relayJson(d, "linear", "/graphql", { kr, body: { query: "{ viewer { id } }" } })).status, 200);
  assert.equal(up.last().headers.authorization, KEYS.LINEAR_API_KEY);
  assert.equal(up.last().headers["x-api-key"], undefined, "the agent token is not forwarded");

  assert.equal((await relayJson(d, "notion", "/v1/search", { kr, body: {} })).status, 200);
  assert.equal(up.last().headers.authorization, `Bearer ${KEYS.NOTION_TOKEN}`);
  assert.equal(up.last().headers["notion-version"], "2022-06-28");

  const entries = await waitForLog(d.meter, 3);
  assert.ok(entries.every((e) => e.allowed && e.costUsd === 0));
  const { decide } = await import("./policy");
  const p = await decide({ name: LEAF, provider: "stripe" }, d);
  assert.deepEqual(p.levels.map((l) => l.used?.stripe), [1, 1]);
  assert.deepEqual(p.levels.map((l) => l.used?.linear), [1, 1]);
});

test("forwarding: Gemini takes the token from ?key= or x-goog-api-key, strips it, injects the real key and charges per request", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const byQuery = await relayJson(d, "gemini", "/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
    kr: "",
    headers: { "x-api-key": "" },
    query: `?alt=sse&key=${kr}`,
    body: { contents: [] },
  });
  assert.equal(byQuery.status, 200, byQuery.text);
  assert.equal(up.last().url, "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
  assert.equal(up.last().headers["x-goog-api-key"], KEYS.GEMINI_API_KEY);

  const byHeader = await relayJson(d, "gemini", "/v1beta/models/gemini-2.5-flash:generateContent", { kr: "", headers: { "x-api-key": "", "x-goog-api-key": kr }, body: {} });
  assert.equal(byHeader.status, 200);
  assert.equal(up.last().headers["x-goog-api-key"], KEYS.GEMINI_API_KEY);

  assert.equal((await relayJson(d, "gemini", "/v1beta/models", { kr })).status, 200, "model lists are free");
  const refused = await relayJson(d, "gemini", "/v1beta/cachedContents", { kr, body: {} });
  assert.equal(refused.status, 403);
  assert.match(refused.reason!, /doesn't forward POST \/v1beta\/cachedContents to gemini/);

  const entries = await waitForLog(d.meter, 4);
  const charged = entries.filter((e) => e.allowed).map((e) => e.costUsd);
  assert.deepEqual(charged.sort(), [0, 0.01, 0.01]);
});

test("forwarding: weather adds ?appid=<the relay's key> upstream, keeps the query, and never sends the token", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const r = await relayJson(d, "weather", "/data/2.5/weather", { kr, query: "?q=Tokyo&units=metric", headers: { authorization: `Bearer ${kr}` } });
  assert.equal(r.status, 200, r.text);
  assert.equal(up.last().method, "GET");
  assert.equal(up.last().url, `/data/2.5/weather?q=Tokyo&units=metric&appid=${KEYS.OPENWEATHER_API_KEY}`);
  assert.equal(up.last().headers.authorization, undefined, "the kr1 token never reaches OpenWeatherMap");
  assert.equal(up.last().headers["x-api-key"], undefined);
  assert.ok(!JSON.stringify(up.last()).includes(kr), "not in the URL or any header");

  // Geocoding (city name to coordinates) is a read too.
  const geo = await relayJson(d, "weather", "/geo/1.0/direct", { kr, query: "?q=Tokyo&limit=1" });
  assert.equal(geo.status, 200, geo.text);
  assert.equal(up.last().url, `/geo/1.0/direct?q=Tokyo&limit=1&appid=${KEYS.OPENWEATHER_API_KEY}`);

  const entries = await waitForLog(d.meter, 2);
  assert.deepEqual(entries.filter((e) => e.provider === "weather" && e.allowed).map((e) => e.costUsd), [0, 0]);
  assert.ok(!JSON.stringify(entries).includes(KEYS.OPENWEATHER_API_KEY), "the log never holds the key");
  const { decide } = await import("./policy");
  const p = await decide({ name: LEAF, provider: "weather" }, d);
  assert.deepEqual(p.levels.map((l) => l.used?.weather), [2, 2]);
});

test("forwarding: a client's own appid is dropped, never forwarded and never replaces the relay's key", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  for (const theirs of [kr, "attacker-owned-openweather-key-000"]) {
    const r = await relayJson(d, "weather", "/data/2.5/weather", { kr, query: `?q=Tokyo&appid=${theirs}&units=metric` });
    assert.equal(r.status, 200, r.text);
    const sent = new URL(up.last().url, "http://x");
    assert.deepEqual(sent.searchParams.getAll("appid"), [KEYS.OPENWEATHER_API_KEY]);
    assert.equal(sent.searchParams.get("q"), "Tokyo");
    assert.equal(sent.searchParams.get("units"), "metric");
    assert.ok(!up.last().url.includes(theirs));
  }
});

test("forwarding: weather refuses writes before sending and counts toward relay.max.weather", async () => {
  const d = deps();
  const kr = await tokenFor(agent, LEAF);
  const seen = up.seen.length;
  const post = await relayJson(d, "weather", "/data/2.5/weather", { kr, query: "?q=Tokyo", body: {} });
  assert.equal(post.status, 403);
  assert.match(post.reason!, /doesn't forward POST \/data\/2\.5\/weather to weather; allowed: GET \/data\/2\.5\/\*, GET \/geo\/1\.0\/\*/);
  const old = await relayJson(d, "weather", "/v1/forecast", { kr, query: "?latitude=35.68&longitude=139.69" });
  assert.equal(old.status, 403, "Open-Meteo's /v1/forecast is not an OpenWeatherMap path");
  assert.equal(up.seen.length, seen, "never sent");

  // A count cap on the agent: the second call is refused before it is sent.
  const capped = makeDeps(
    new MemoryChain([level("acme.eth", admin.address, bundle(ALL)), level(LEAF, agent.address, bundle("weather", { maxes: { weather: 1 } }))]),
    { RELAY_UPSTREAM_WEATHER: up.url, OPENWEATHER_API_KEY: KEYS.OPENWEATHER_API_KEY },
  );
  const query = "?q=Tokyo&units=metric";
  assert.equal((await relayJson(capped, "weather", "/data/2.5/weather", { kr, query })).status, 200);
  const before = up.seen.length;
  const over = await relayJson(capped, "weather", "/data/2.5/weather", { kr, query });
  assert.equal(over.status, 403);
  assert.match(over.reason!, /weather/);
  assert.equal(up.seen.length, before, "refused before it is sent");
});

test("forwarding: weather without OPENWEATHER_API_KEY answers 503 naming the variable, and sends nothing", async () => {
  const d = deps({ OPENWEATHER_API_KEY: "" });
  const seen = up.seen.length;
  const r = await relayJson(d, "weather", "/data/2.5/weather", { kr: await tokenFor(agent, LEAF), query: "?q=Tokyo&units=metric" });
  assert.equal(r.status, 503);
  assert.equal(r.error, "provider not configured");
  assert.match(r.reason!, /no weather key \(OPENWEATHER_API_KEY\)/);
  assert.equal(up.seen.length, seen);
});

test("forwarding: the weather key is redacted from a failed fetch and from anything OpenWeatherMap echoes back", async () => {
  const key = KEYS.OPENWEATHER_API_KEY;
  const kr = await tokenFor(agent, LEAF);
  const failing = deps();
  failing.fetch = (async (url: string | URL | Request) => {
    throw new Error(`getaddrinfo ENOTFOUND ${String(url)}`);
  }) as typeof fetch;
  const r = await relayJson(failing, "weather", "/data/2.5/weather", { kr, query: "?q=Tokyo" });
  assert.equal(r.status, 502);
  assert.equal(r.error, "upstream error");
  assert.match(r.reason!, /appid=\[redacted\]/);
  assert.ok(!r.text.includes(key), "not in the response");
  const [entry] = await waitForLog(failing.meter, 1);
  assert.ok(!(entry.reason ?? "").includes(key), "not in the log");

  const echoing = deps();
  echoing.fetch = (async (url: string | URL | Request) =>
    new Response(JSON.stringify({ cod: 401, message: `Invalid API key for ${String(url)}` }), {
      status: 401,
      headers: { "content-type": "application/json", location: String(url) },
    })) as typeof fetch;
  const echoed = await relayJson(echoing, "weather", "/data/2.5/weather", { kr, query: "?q=Tokyo" });
  assert.equal(echoed.status, 401, "OpenWeatherMap's own status passes through");
  assert.match(echoed.text, /appid=\[redacted\]/);
  assert.ok(!echoed.text.includes(key), "not in the body");
  assert.ok(![...echoed.res.headers.values()].some((v) => v.includes(key)), "not in a header");
});

test("forwarding: a provider without a key answers 503 naming the variable to set", async () => {
  const d = deps({ STRIPE_SECRET_KEY: "" });
  const r = await relayJson(d, "stripe", "/v1/customers", { kr: await tokenFor(agent, LEAF) });
  assert.equal(r.status, 503);
  assert.match(r.reason!, /no stripe key \(STRIPE_SECRET_KEY\)/);
});

test("status: lists every catalog provider with category, key state, dollar caps and count unit", async () => {
  process.env.RELAY_DATA_DIR = (await import("./testkit")).tempDir();
  process.env.RELAY_ROOT_NAME = "";
  process.env.OPENAI_API_KEY = "sk-proj-status-test-0123456789";
  process.env.STRIPE_SECRET_KEY = "";
  process.env.OPENWEATHER_API_KEY = "";
  const { GET } = await import("../../app/api/relay/status/route");
  const body = await (await GET()).json();
  assert.equal(body.providers.length, CATALOG.length);
  const byId = Object.fromEntries(body.providers.map((p: { id: string }) => [p.id, p]));
  assert.deepEqual(byId["openai-images"], {
    id: "openai-images",
    label: "OpenAI Images",
    category: "ai",
    configured: true,
    metered: true,
    dollarCaps: true,
    countUnit: "images",
    keyEnv: "OPENAI_API_KEY",
    note: "Image generation; limit by number of images",
  });
  assert.equal(byId.stripe.configured, false);
  assert.equal(byId.stripe.countUnit, "requests");
  assert.equal(byId.stripe.category, "business");
  assert.equal(byId.mock.configured, true);
  assert.deepEqual(byId.weather, {
    id: "weather",
    label: "Weather (OpenWeatherMap)",
    category: "data",
    configured: false,
    metered: false,
    dollarCaps: false,
    countUnit: "requests",
    keyEnv: "OPENWEATHER_API_KEY",
    note: "Current weather and forecasts by city: /data/2.5/weather?q=Tokyo&units=metric.",
  });
  assert.ok(!JSON.stringify(body).includes("sk-proj-status-test"), "never a key value");
});
