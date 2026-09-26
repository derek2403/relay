// Catalog-driven forwarding: each auth kind, default headers, upstream
// overrides, the route tables for OpenAI Images and Gemini, and the status list.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CATALOG, PROVIDER_IDS } from "./catalog";
import { loadConfig, upstreamEnvName } from "./config";
import { PROVIDER_SPECS, upstreamRequestHeaders } from "./providers";
import { routeFor } from "./routes";
import { MemoryChain, bundle, fakeUpstream, level, makeDeps, relayJson, tokenFor, waitForLog } from "./testkit";

const KEYS = {
  OPENAI_API_KEY: "sk-proj-OPENAI-REAL-0123456789",
  GEMINI_API_KEY: "AIza-GEMINI-REAL-0123456789",
  LINEAR_API_KEY: "lin_api_LINEAR-REAL-0123456789",
  NOTION_TOKEN: "ntn_NOTION-REAL-0123456789",
  STRIPE_SECRET_KEY: "sk_test_STRIPE-REAL-0123456789",
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
  const upstreams = Object.fromEntries(["gemini", "linear", "notion", "stripe", "openai-images"].map((id) => [upstreamEnvName(id as never), up.url]));
  return makeDeps(chain, { ...KEYS, ...upstreams, ...env });
}

test("catalog: every provider has a spec; codex and openai-images share the OpenAI key", () => {
  assert.deepEqual(Object.keys(PROVIDER_SPECS).sort(), [...PROVIDER_IDS].sort());
  assert.deepEqual(PROVIDER_IDS, ["claude", "codex", "openai-images", "gemini", "github", "railway", "vercel", "linear", "canva", "hubspot", "mailchimp", "stripe", "notion", "slack", "mock"]);
  const config = loadConfig({ OPENAI_API_KEY: KEYS.OPENAI_API_KEY });
  assert.equal(config.keyFor("codex"), KEYS.OPENAI_API_KEY);
  assert.equal(config.keyFor("openai-images"), KEYS.OPENAI_API_KEY);
  assert.ok(config.isConfigured("openai-images"));
  assert.ok(!config.isConfigured("stripe"), "no key, not configured");
  assert.ok(config.isConfigured("mock"), "the mock needs no key");
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
  assert.ok(!JSON.stringify(body).includes("sk-proj-status-test"), "never a key value");
});
