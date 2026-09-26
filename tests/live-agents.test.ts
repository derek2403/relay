import assert from "node:assert/strict";
import test from "node:test";

import {
  aboveLevels,
  classifyResponse,
  decisionsFor,
  keysUnderRoot,
  logCost,
  logOutcome,
  markFor,
  matchLogEntry,
  relayUrl,
  requestHeaders,
  sendsBody,
  sessionCheck,
  sessionLabel,
  firstTeam,
  teamFor,
  tryMethods,
  trySample,
  tryTokenExpiry,
  usageLines,
  watchedUser,
} from "../components/live/agents/model";
import { SAMPLE_REQUESTS, sampleRequest } from "../lib/relay/browser";
import type { LevelView, LogEntry } from "../lib/relay/types";

const A = "0x1111111111111111111111111111111111111111" as const;
const B = "0x2222222222222222222222222222222222222222" as const;

const entry = (patch: Partial<LogEntry>): LogEntry => ({
  ts: 10_000,
  name: "bot.alice.dev.eng.acme.eth",
  provider: "mock",
  method: "POST",
  path: "/v1/messages",
  allowed: true,
  reason: null,
  status: 200,
  costUsd: 0.01,
  estimated: false,
  signer: A,
  ...patch,
});

const level = (patch: Partial<LevelView>): LevelView => ({
  name: "alice.dev.eng.acme.eth",
  registry: null,
  resolver: null,
  subregistry: null,
  status: "registered",
  owner: null,
  expiry: null,
  resource: null,
  bundle: null,
  spent: {},
  checks: { registryVerified: null, resolverVerified: null, canonical: null },
  ...patch,
});

test("header choice follows SRC samples: x-api-key for claude/mock, Bearer otherwise", () => {
  assert.deepEqual(requestHeaders(sampleRequest("mock").auth, "t", true), { "x-api-key": "t", "content-type": "application/json" });
  assert.deepEqual(requestHeaders(sampleRequest("claude").auth, "t", false), { "x-api-key": "t" });
  assert.deepEqual(requestHeaders(sampleRequest("codex").auth, "t", false), { authorization: "Bearer t" });
  assert.deepEqual(requestHeaders(sampleRequest("stripe").auth, "t", false), { authorization: "Bearer t" });
});

test("try-a-call samples: weather is a read-only GET for Tokyo, the others come from lib/relay/browser", () => {
  const weather = trySample("weather");
  assert.equal(weather.method, "GET");
  assert.equal(weather.body, null);
  assert.equal(weather.path, SAMPLE_REQUESTS.weather?.path ?? "/data/2.5/weather?q=Tokyo&units=metric");
  assert.match(weather.path, /^\/data\/2\.5\/weather\?q=Tokyo&units=metric$/);
  assert.equal(relayUrl("weather", weather.path), `/api/relay/weather${weather.path}`);
  assert.deepEqual(requestHeaders(weather.auth, "t", sendsBody(weather.method, weather.body ?? "")), { authorization: "Bearer t" });
  assert.deepEqual(trySample("codex"), sampleRequest("codex"));
  assert.deepEqual(trySample("stripe"), { method: "GET", path: "/", body: null, auth: "bearer" });
  assert.deepEqual(tryMethods("weather"), ["GET"]);
  assert.deepEqual(tryMethods("codex"), ["GET", "POST"]);
});

test("body only for non-GET requests with content; url joins the path", () => {
  assert.equal(sendsBody("GET", "{}"), false);
  assert.equal(sendsBody("POST", "  "), false);
  assert.equal(sendsBody("POST", "{}"), true);
  assert.equal(relayUrl("github", "/user"), "/api/relay/github/user");
  assert.equal(relayUrl("github", "user"), "/api/relay/github/user");
});

test("try token lives 10 minutes, never past the session", () => {
  assert.equal(tryTokenExpiry(1000, null), 1600);
  assert.equal(tryTokenExpiry(1000, 1300), 1300);
  assert.equal(tryTokenExpiry(1000, 5000), 1600);
});

test("result classification: relay refusals vs upstream answers", () => {
  const refused = classifyResponse(403, JSON.stringify({ error: "denied", reason: "cap reached" }), 1);
  assert.equal(refused.denied, true);
  assert.equal(refused.reason, "cap reached");
  const noReason = classifyResponse(401, JSON.stringify({ error: "bad token" }), 1);
  assert.equal(noReason.reason, "bad token");
  // Upstream errors come as objects, not relay { error: string }.
  const upstream = classifyResponse(400, JSON.stringify({ error: { type: "invalid_request" } }), 1);
  assert.equal(upstream.denied, false);
  assert.equal(classifyResponse(429, JSON.stringify({ error: "slow down" }), 1).denied, false);
  const ok = classifyResponse(200, '{"a":1}', 5);
  assert.deepEqual(ok, { status: 200, denied: false, reason: null, body: '{\n  "a": 1\n}', sentAt: 5 });
  assert.equal(classifyResponse(502, "<html>bad gateway</html>", 1).body, "<html>bad gateway</html>");
  assert.equal(classifyResponse(502, "<html>bad gateway</html>", 1).denied, false);
});

test("log matching: same provider, after the send (2 s slack), by name or signer", () => {
  const log = [entry({ ts: 20_000, provider: "codex" }), entry({ ts: 9_000, name: null, signer: A.toUpperCase().replace("0X", "0x") as `0x${string}` }), entry({ ts: 5_000 })];
  assert.equal(matchLogEntry(log, { sentAt: 10_500, provider: "mock", name: "other.acme.eth", address: A })?.ts, 9_000);
  assert.equal(matchLogEntry(log, { sentAt: 10_500, provider: "codex", name: "bot.alice.dev.eng.acme.eth", address: B })?.ts, 20_000);
  assert.equal(matchLogEntry(log, { sentAt: 30_000, provider: "mock", name: "bot.alice.dev.eng.acme.eth", address: A }), undefined);
  assert.equal(matchLogEntry(undefined, { sentAt: 0, provider: "mock", name: undefined, address: A }), undefined);
});

test("session check: live only when every level is registered", () => {
  const levels = [
    { name: "acme.eth", status: "registered" as const, expiry: null },
    { name: "bot.acme.eth", status: "registered" as const, expiry: 500 },
  ];
  assert.deepEqual(
    { ...sessionCheck(levels, "bot.acme.eth", 100), leaf: undefined },
    { leaf: undefined, live: true, expiry: 500, ended: false },
  );
  assert.equal(sessionCheck(levels, "bot.acme.eth", 600).ended, true);
  assert.equal(sessionCheck([{ ...levels[0], status: "available" }, levels[1]], "bot.acme.eth", 100).ended, true);
  assert.equal(sessionCheck(levels, "nope.acme.eth", 100).ended, false);
});

test("session labels", () => {
  assert.equal(sessionLabel(200, "live", 0), "…");
  assert.equal(sessionLabel(200, "live", 100), "ends in 1m 40s");
  assert.equal(sessionLabel(200, "live", 300), "ended");
  assert.equal(sessionLabel(null, "live", 100), "no expiry");
  assert.equal(sessionLabel(undefined, "unknown", 100), "not checked");
  assert.equal(sessionLabel(200, "removed", 100), "removed");
});

test("log outcome, cost and subtree decisions", () => {
  assert.deepEqual(logOutcome(entry({})), { tone: "ok", text: "ok 200", loud: false });
  assert.deepEqual(logOutcome(entry({ allowed: false, reason: "cap reached" })), { tone: "refused", text: "refused", loud: false });
  assert.equal(logOutcome(entry({ reason: "killed: access revoked" })).text, "killed");
  assert.equal(logOutcome(entry({ allowed: false, reason: "access revoked: removed" })).text, "revoked");
  assert.equal(logCost(entry({ costUsd: 0.012, estimated: true })), "$0.012*");
  assert.equal(logCost(entry({ costUsd: null })), "—");
  const log = [entry({ name: "alice.dev.eng.acme.eth" }), entry({ name: "bob.dev.eng.acme.eth" }), entry({ ts: 1, name: "x.alice.dev.eng.acme.eth" })];
  assert.equal(decisionsFor(log, "alice.dev.eng.acme.eth", 0).length, 2);
  assert.equal(decisionsFor(log, "alice.dev.eng.acme.eth", 5).length, 1);
});

test("usage lines: dollars for priced APIs, counts when limited or unpriced", () => {
  const l = level({ bundle: { keys: ["codex", "github"], caps: { codex: 10 }, maxes: { github: 4 }, period: "month" }, spent: { codex: 9 }, used: { github: 1 } });
  assert.deepEqual(usageLines(l, "codex"), [{ text: "$9.00 of $10.00", pct: 90, tone: "warn" }]);
  assert.deepEqual(usageLines(l, "github"), [{ text: "1 of 4 requests", pct: 25, tone: "ok" }]);
  const none = level({ bundle: { keys: ["codex"], caps: {}, maxes: {}, period: "month" } });
  assert.deepEqual(usageLines(none, "codex"), [{ text: "$0.00 spent, no cap here", pct: null, tone: "ok" }]);
});

test("above levels and which user is watched", () => {
  const levels = { "dev.eng.acme.eth": level({ name: "dev.eng.acme.eth" }), "acme.eth": level({ name: "acme.eth" }) };
  assert.deepEqual(aboveLevels("alice.dev.eng.acme.eth", levels).map((l) => l.name), ["dev.eng.acme.eth", "acme.eth"]);
  assert.equal(watchedUser("acme.eth", "alice.dev.eng.acme.eth", null, "bot.alice.dev.eng.acme.eth"), "alice.dev.eng.acme.eth");
  assert.equal(watchedUser("acme.eth", "alice.dev.eng.acme.eth", { user: "bob.dev.eng.acme.eth", selectedAt: "bot.alice.dev.eng.acme.eth" }, "bot.alice.dev.eng.acme.eth"), "bob.dev.eng.acme.eth");
  // Selection moved after the pick: follow the tree again.
  assert.equal(watchedUser("acme.eth", "carol.dev.eng.acme.eth", { user: "bob.dev.eng.acme.eth", selectedAt: "x" }, "carol.dev.eng.acme.eth"), "carol.dev.eng.acme.eth");
  assert.equal(watchedUser("acme.eth", "alice.dev.eng.other.eth", null, "alice.dev.eng.other.eth"), null);
  assert.equal(teamFor(null, "cloudops.dev.acme.eth"), "cloudops.dev.acme.eth");
  assert.equal(teamFor("alice.ops.eng.acme.eth", "cloudops.dev.acme.eth"), "ops.eng.acme.eth");
  assert.equal(teamFor(null, null), null);
  const tree = [{ name: "acme.eth", type: "company" }, { name: "dev.acme.eth", type: "department" }, { name: "cloudops.dev.acme.eth", type: "team" }, { name: "web.dev.acme.eth", type: "team" }];
  assert.equal(firstTeam(tree), "cloudops.dev.acme.eth");
  assert.equal(firstTeam(tree.slice(0, 2)), null);
});

test("keys under root and catalog marks", () => {
  const keys = [
    { address: A, privateKey: "0x01" as const, name: "bot.acme.eth", createdAt: 0 },
    { address: B, privateKey: "0x02" as const, name: "bot.other.eth", createdAt: 0 },
    { address: B, privateKey: "0x03" as const, createdAt: 0 },
  ];
  assert.deepEqual(keysUnderRoot(keys, "acme.eth").map((k) => k.name), ["bot.acme.eth"]);
  assert.equal(keysUnderRoot(keys, null).length, 2);
  assert.equal(markFor("claude"), "anthropic");
  assert.equal(markFor("openai-images"), "openai");
  assert.equal(markFor("codex"), "codex");
});
