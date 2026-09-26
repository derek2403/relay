// Count limits (relay.max.<api>): reservations before forwarding, image `n`,
// charging only on success, and the "access revoked" refusal.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { namehash } from "../ens/names";
import { spendKey } from "./meter";
import { planImages } from "./plan";
import { decide, reserve } from "./policy";
import { MemoryChain, bundle, fakeUpstream, level, makeDeps, relay, relayJson, tokenFor, waitForLog } from "./testkit";

let up: Awaited<ReturnType<typeof fakeUpstream>>;
before(async () => {
  up = await fakeUpstream((req, res, body) => {
    const url = req.url!.split("?")[0];
    const reply = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (url.startsWith("/v1/images/")) {
      if (req.headers["x-test"] === "fail") return reply(400, { error: { message: "content policy" } });
      const n = (req.headers["content-type"] ?? "").includes("json") ? (JSON.parse(body).n ?? 1) : 1;
      return reply(200, { created: 1, data: Array.from({ length: n }, () => ({ b64_json: "aGk=" })) });
    }
    if (req.headers["x-test"] === "fail") return reply(500, { error: "boom" });
    // Slow enough that parallel calls overlap.
    setTimeout(() => !res.destroyed && reply(200, { ok: true }), 50);
  });
});
after(() => up.close());

const agent = privateKeyToAccount(generatePrivateKey());
const admin = privateKeyToAccount(generatePrivateKey());
const USER = "derek.dev.acme.eth";
const AGENT = `codex.${USER}`;
const ALL = "codex,openai-images,stripe,github,mock";

function tree(agentLimits: Parameters<typeof bundle>[1] = {}, userLimits: Parameters<typeof bundle>[1] = {}) {
  return new MemoryChain([
    level("acme.eth", admin.address, bundle(ALL, { maxes: { stripe: 10000, "openai-images": 1000 } })),
    level("dev.acme.eth", admin.address, bundle(ALL, { maxes: { "openai-images": 50 } })),
    level(USER, admin.address, bundle(ALL, userLimits)),
    level(AGENT, agent.address, bundle(ALL, { period: "total", ...agentLimits })),
  ]);
}

const env = () => ({ OPENAI_API_KEY: "sk-proj-OPENAI-0123456789", STRIPE_SECRET_KEY: "sk_test_STRIPE_0123456789", RELAY_UPSTREAM_OPENAI_IMAGES: up.url, RELAY_UPSTREAM_STRIPE: up.url });

test("count caps: 12 parallel requests against a 3-request limit -> exactly 3 forwarded and counted at every level", async () => {
  const d = makeDeps(tree({ maxes: { stripe: 3 } }), env());
  const kr = await tokenFor(agent, AGENT);
  const before = up.seen.length;
  const results = await Promise.all(Array.from({ length: 12 }, () => relayJson(d, "stripe", "/v1/charges", { kr, method: "GET" })));
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  const refused = results.filter((r) => r.status === 403);
  assert.equal(refused.length, 9);
  assert.ok(refused.every((r) => /codex\.derek\.dev\.acme\.eth has used its stripe limit \(3 requests\)/.test(r.reason ?? "")), refused.map((r) => r.reason).join("\n"));
  assert.equal(up.seen.length - before, 3, "refused calls never reached the provider");

  const p = await decide({ name: AGENT, provider: "stripe" }, d);
  assert.deepEqual(p.levels.map((l) => l.used?.stripe), [3, 3, 3, 3]);
  assert.equal(p.allowed, false);
  assert.equal(p.remainingCount, 0);
  // Counts are kept per period like spend: the agent's is "total", the others monthly.
  const month = new Date().toISOString().slice(0, 7);
  assert.equal(d.meter.used(spendKey(namehash(AGENT), "7", "stripe", "total")), 3);
  assert.equal(d.meter.used(spendKey(namehash("acme.eth"), "7", "stripe", month)), 3);
});

test("count caps: failed calls don't count; the policy view shows used and remainingCount", async () => {
  const d = makeDeps(tree({ maxes: { stripe: 2 } }), env());
  const kr = await tokenFor(agent, AGENT);
  assert.equal((await relayJson(d, "stripe", "/v1/charges", { kr, method: "GET", headers: { "x-test": "fail" } })).status, 500);
  assert.equal((await relayJson(d, "stripe", "/v1/charges", { kr, method: "GET" })).status, 200);
  await waitForLog(d.meter, 2);
  const p = await decide({ name: AGENT, provider: "stripe" }, d);
  assert.equal(p.allowed, true);
  assert.equal(p.remainingCount, 1);
  assert.equal(p.levels[3].used?.stripe, 1);
  assert.equal(p.levels[3].spent.stripe, 0);
});

test("reserve: counts held by calls in flight block others, and settle to the real count", async () => {
  const d = makeDeps(tree({ maxes: { "openai-images": 2 } }), env());
  const p = await decide({ name: AGENT, provider: "openai-images" }, d);
  const now = new Date();
  const a = reserve(p.levels, "openai-images", 0.04, d.meter, now, 1);
  const b = reserve(p.levels, "openai-images", 0.08, d.meter, now, 2);
  assert.ok(a.ok);
  assert.ok(!b.ok);
  assert.match(b.reason, /codex\.derek\.dev\.acme\.eth has 1 of its 2 images left, fewer than this call asks for \(2\)/);
  const during = await decide({ name: AGENT, provider: "openai-images" }, d);
  assert.equal(during.levels[3].used?.["openai-images"], 1, "reservations show as used");
  a.reservation.settle(0, 0); // the call failed: nothing counted
  const after = await decide({ name: AGENT, provider: "openai-images" }, d);
  assert.equal(after.levels[3].used?.["openai-images"], 0);
});

test("images: the request's n is counted and priced per image; a second attempt past the limit is refused", async () => {
  // The demo's image subagent: 1 image. Its parents allow more.
  const d = makeDeps(tree({ maxes: { "openai-images": 1 } }, { maxes: { "openai-images": 5 } }), env());
  const kr = await tokenFor(agent, AGENT);
  const first = await relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { model: "gpt-image-1", prompt: "a header image" } });
  assert.equal(first.status, 200, first.text);
  assert.equal(up.last().headers.authorization, "Bearer sk-proj-OPENAI-0123456789");
  const second = await relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { model: "gpt-image-1", prompt: "another" } });
  assert.equal(second.status, 403);
  assert.match(second.reason!, /has used its openai-images limit \(1 image\)/);
  const [entry] = (await waitForLog(d.meter, 2)).filter((e) => e.allowed);
  assert.equal(entry.costUsd, 0.04);
  const p = await decide({ name: AGENT, provider: "openai-images" }, d);
  assert.deepEqual(p.levels.map((l) => l.used?.["openai-images"]), [1, 1, 1, 1]);
});

test("images: n counts in full, parallel requests can't pass the limit, errors don't count, multipart edits count too", async () => {
  const d = makeDeps(tree({ maxes: { "openai-images": 3 } }), env());
  const kr = await tokenFor(agent, AGENT);
  const two = await relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { prompt: "x", n: 2 } });
  assert.equal(two.status, 200);
  const tooMany = await relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { prompt: "x", n: 2 } });
  assert.equal(tooMany.status, 403);
  assert.match(tooMany.reason!, /has 1 of its 3 images left, fewer than this call asks for \(2\)/);
  const failed = await relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { prompt: "x" }, headers: { "x-test": "fail" } });
  assert.equal(failed.status, 400, "the provider's error passes through");

  const form = new FormData();
  form.set("prompt", "edit it");
  form.set("n", "1");
  form.set("image", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");
  const edit = await relay(d, "openai-images", "/v1/images/edits", { kr, raw: form });
  assert.equal(edit.status, 200);
  await edit.text();
  assert.match(String(up.last().headers["content-type"]), /multipart\/form-data/);

  const parallel = await Promise.all([1, 2, 3].map(() => relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { prompt: "x" } })));
  assert.ok(parallel.every((r) => r.status === 403), "the limit is used up");
  await waitForLog(d.meter, 7);
  const p = await decide({ name: AGENT, provider: "openai-images" }, d);
  assert.equal(p.levels[3].used?.["openai-images"], 3);
  assert.equal(p.levels[3].spent["openai-images"], 0.12);
});

test("images: parallel single-image requests against a 1-image limit -> exactly one", async () => {
  const d = makeDeps(tree({ maxes: { "openai-images": 1 } }), env());
  const kr = await tokenFor(agent, AGENT);
  const results = await Promise.all(Array.from({ length: 6 }, () => relayJson(d, "openai-images", "/v1/images/generations", { kr, body: { prompt: "x" } })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
});

test("planImages: n from JSON or multipart, default 1; unreadable bodies and bad n are refused", async () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  assert.deepEqual(await planImages(enc({ prompt: "x" }), "application/json"), { ok: true, n: 1, streaming: false });
  assert.deepEqual(await planImages(enc({ n: 4, stream: true }), "application/json"), { ok: true, n: 4, streaming: true });
  for (const n of [0, 11, 2.5, "two", -1, true]) {
    const r = await planImages(enc({ n }), "application/json");
    assert.ok(!r.ok && r.status === 400, `n=${JSON.stringify(n)}`);
  }
  assert.ok(!(await planImages(new TextEncoder().encode("not json"), "text/plain")).ok);
  const form = new FormData();
  form.set("n", "3");
  const req = new Request("http://x", { method: "POST", body: form });
  const bytes = new Uint8Array(await req.arrayBuffer());
  assert.deepEqual(await planImages(bytes, req.headers.get("content-type")), { ok: true, n: 3, streaming: false });
  assert.ok(!(await planImages(bytes, "multipart/form-data; boundary=wrong")).ok);
});

test("revoked: a removed level refuses with 403 'access revoked' naming that level", async () => {
  const chain = tree();
  const d = makeDeps(chain, env());
  const kr = await tokenFor(agent, AGENT);
  assert.equal((await relayJson(d, "mock", "/v1/messages", { kr, body: {} })).status, 200);
  chain.remove(USER);
  const r = await relayJson(d, "mock", "/v1/messages", { kr, body: {} });
  assert.equal(r.status, 403);
  assert.equal(r.error, "access revoked");
  assert.equal(r.reason, "access revoked: derek.dev.acme.eth was removed or expired. Run relay login.");
  // A recently good caller's refusal is logged with the same reason.
  const [entry] = await waitForLog(d.meter, 2);
  assert.equal(entry.allowed, false);
  assert.equal(entry.reason, r.reason);

  // Expiry reads the same as removal, and other denials keep their wording.
  const expired = makeDeps(new MemoryChain(chain.levels.map((l) => (l.name === AGENT ? { ...l, status: "available", owner: null } : l))), env());
  const e = await relayJson(expired, "mock", "/v1/messages", { kr, body: {} });
  assert.equal(e.reason, `access revoked: ${AGENT} was removed or expired. Run relay login.`);
  const denied = await relayJson(makeDeps(tree({}, {}), env()), "claude", "/v1/messages", { kr, body: {} });
  assert.equal(denied.error, "denied");
  assert.match(denied.reason!, /^acme\.eth does not allow claude/);
});
