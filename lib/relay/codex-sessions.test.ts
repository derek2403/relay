// Codex logins: registration and revocation, the login route (the typed ENS name, unknown, expired
// and revoked logins, a removed name) and the usage-limit headers and 429 Codex shows.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { codexLoginMessage, codexLogoutMessage, loginSecretHash, newLoginSecret } from "./codex-login";
import { codexCapUsage, codexLimitHeaders, usagePromo, usedPercent } from "./codex-limits";
import { CodexSessionStore, deleteCodexSession, handleCodexSessionRequest, postCodexSession } from "./codex-sessions";
import { charge, decide, reserve } from "./policy";
import { MemoryChain, bundle, fakeUpstream, level, makeDeps, nowSec, relayJson, tokenFor } from "./testkit";

const ROOT_OWNER = privateKeyToAccount(generatePrivateKey());
const member = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const MEMBER = "derek.eng.acme.eth";
const AGENT = `codex.${MEMBER}`;
const RELAY = "http://localhost:3000";
const OPENAI_KEY = "sk-proj-REAL-OPENAI-KEY-0123456789";

const completed = {
  type: "response.completed",
  response: { id: "resp_1", object: "response", model: "gpt-5.3-codex", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
};
let up: Awaited<ReturnType<typeof fakeUpstream>>;

before(async () => {
  up = await fakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "x-codex-primary-used-percent": "3" });
    res.end(`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`);
  });
});
after(() => up.close());

type Setup = { agentBundle?: ReturnType<typeof bundle>; agentExpiry?: number };

function setup(o: Setup = {}) {
  const chain = new MemoryChain([
    level("acme.eth", ROOT_OWNER.address, bundle("codex", { caps: { codex: 100 } })),
    level("eng.acme.eth", ROOT_OWNER.address, bundle("codex", { caps: { codex: 50 } })),
    level(MEMBER, member.address, bundle("codex", { caps: { codex: 2 } })),
    level(AGENT, agent.address, o.agentBundle ?? bundle("codex", { caps: { codex: 1 }, period: "total" }), { expiry: o.agentExpiry ?? nowSec() + 8 * 3600 }),
  ]);
  const deps = makeDeps(chain, { RELAY_UPSTREAM_CODEX: up.url, OPENAI_API_KEY: OPENAI_KEY });
  const sessions = new CodexSessionStore(path.join(deps.config.dataDir, "codex-sessions.json"));
  return { chain, deps: { ...deps, sessions } };
}
type Deps = ReturnType<typeof setup>["deps"];

async function register(deps: Deps, o: { signer?: typeof agent; exp?: number; iat?: number; relay?: string; memberName?: string; agentName?: string; secret?: string } = {}) {
  const secret = o.secret ?? newLoginSecret();
  const iat = o.iat ?? nowSec();
  const claim = { agent: o.agentName ?? AGENT, member: o.memberName ?? MEMBER, relay: o.relay ?? RELAY, secretHash: loginSecretHash(secret), iat, exp: o.exp ?? iat + 3600 };
  const signature = await (o.signer ?? agent).signMessage({ message: codexLoginMessage(claim) });
  const res = await postCodexSession(new Request(`${RELAY}/api/relay/codex/sessions`, { method: "POST", body: JSON.stringify({ ...claim, signature }) }), deps);
  return { secret, res, json: (await res.json()) as { error?: string; reason?: string; exp?: number } };
}

async function revoke(deps: Deps, secret: string, signer = agent) {
  const claim = { relay: RELAY, secretHash: loginSecretHash(secret), iat: nowSec() };
  const signature = await signer.signMessage({ message: codexLogoutMessage(claim) });
  const res = await deleteCodexSession(new Request(`${RELAY}/api/relay/codex/sessions`, { method: "DELETE", body: JSON.stringify({ ...claim, signature }) }), deps);
  return { status: res.status, json: (await res.json()) as { revoked?: boolean } };
}

const RESPONSES_BODY = JSON.stringify({ model: "gpt-5.3-codex", stream: true, input: [{ role: "user", content: "hi" }] });

/** A Codex call through a login: the secret in x-relay-login (what `relay login` writes). */
async function codexCall(deps: Deps, secret: string, name: string | null, o: { p?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", originator: "codex_exec" };
  if (name !== null) headers.authorization = `Bearer ${name}`;
  headers["x-relay-login"] = secret;
  const url = `${RELAY}/api/relay/codex/login${o.p ?? "/v1/responses"}`;
  const res = await handleCodexSessionRequest(new Request(url, { method: "POST", headers, body: RESPONSES_BODY }), deps);
  const text = await res.text();
  let json: { error?: { message?: string; type?: string; resets_at?: number } } | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, status: res.status, text, json, message: json?.error?.message ?? "" };
}

// --- Registration ---------------------------------------------------------------------------------

test("the agent key registers a login; the store keeps only the secret's hash", async () => {
  const { deps } = setup();
  const { secret, res, json } = await register(deps);
  assert.equal(res.status, 201, JSON.stringify(json));
  const file = fs.readFileSync(deps.sessions.file, "utf8");
  assert.ok(!file.includes(secret), "the secret itself is never stored");
  assert.ok(file.includes(loginSecretHash(secret)));
  assert.equal((fs.statSync(deps.sessions.file).mode & 0o777).toString(8), "600");
  const stored = deps.sessions.get(loginSecretHash(secret), nowSec());
  assert.equal(stored?.agent, AGENT);
  assert.equal(stored?.member, MEMBER);
  assert.equal(stored?.signer, agent.address);
});

test("registration refuses a bad signature, a signer that doesn't own the agent, and the member's own key", async () => {
  const { deps } = setup();
  // Signed over different fields than the ones sent: recovers some other address, which owns nothing.
  const secret = newLoginSecret();
  const claim = { agent: AGENT, member: MEMBER, relay: RELAY, secretHash: loginSecretHash(secret), iat: nowSec(), exp: nowSec() + 600 };
  const signature = await agent.signMessage({ message: codexLoginMessage({ ...claim, exp: claim.exp + 1 }) });
  const res = await postCodexSession(new Request(`${RELAY}/x`, { method: "POST", body: JSON.stringify({ ...claim, signature }) }), deps);
  assert.equal(res.status, 401);
  assert.equal((await register(deps, { signer: stranger })).res.status, 401);
  const byMember = await register(deps, { signer: member });
  assert.equal(byMember.res.status, 401, "the login is signed by the agent's key, the owner of codex.<member>");
  assert.match(byMember.json.reason ?? "", /does not own codex\.derek/);
  const garbage = await postCodexSession(new Request(`${RELAY}/x`, { method: "POST", body: JSON.stringify({ ...claim, signature: "0x1234" }) }), deps);
  assert.equal(garbage.status, 401);
  assert.equal(Object.keys(deps.sessions.data.sessions).length, 0);
});

test("registration caps the login at 24 h and at the agent's ENS expiry", async () => {
  const { deps } = setup({ agentExpiry: nowSec() + 2 * 3600 });
  const long = await register(deps, { exp: nowSec() + 25 * 3600 });
  assert.equal(long.res.status, 400);
  assert.match(long.json.reason ?? "", /at most 24 h/);
  const past = await register(deps, { exp: nowSec() + 3 * 3600 });
  assert.equal(past.res.status, 400);
  assert.match(past.json.reason ?? "", /would outlast codex\.derek/);
  assert.equal((await register(deps, { exp: nowSec() + 3600 })).res.status, 201);
  assert.equal((await register(deps, { exp: nowSec() - 1, iat: nowSec() })).res.status, 400, "already expired");
});

test("registration refuses another relay, a stale signature, an agent outside its member and a removed name", async () => {
  const { deps, chain } = setup();
  assert.match((await register(deps, { relay: "https://evil.example" })).json.reason ?? "", /not this relay/);
  assert.match((await register(deps, { iat: nowSec() - 3600 })).json.reason ?? "", /clock/);
  assert.match((await register(deps, { memberName: "nina.eng.acme.eth" })).json.reason ?? "", /is not an agent of nina/);
  // Only the agent's own member: the agent key can't make the login screen take the company's name.
  for (const above of ["eng.acme.eth", "acme.eth"]) {
    const r = await register(deps, { memberName: above });
    assert.equal(r.res.status, 400, above);
    assert.match(r.json.reason ?? "", /is not an agent of/);
  }
  chain.remove(MEMBER);
  const gone = await register(deps);
  assert.equal(gone.res.status, 403);
  assert.equal(gone.json.error, "access revoked");
});

test("only the key that made a login can revoke it", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  assert.equal((await revoke(deps, secret, stranger)).status, 401);
  assert.deepEqual(await revoke(deps, secret), { status: 200, json: { revoked: true } });
  assert.deepEqual(await revoke(deps, secret), { status: 200, json: { revoked: false } });
  assert.equal(deps.sessions.get(loginSecretHash(secret), nowSec()), null);
});

test("a secret hash belongs to one login: another agent's key can't take it over", async () => {
  const { deps, chain } = setup();
  const otherAgent = privateKeyToAccount(generatePrivateKey());
  const OTHER_MEMBER = "nina.eng.acme.eth";
  chain.levels.push(level(OTHER_MEMBER, stranger.address, bundle("codex", { caps: { codex: 2 } })));
  chain.levels.push(level(`codex.${OTHER_MEMBER}`, otherAgent.address, bundle("codex", { caps: { codex: 1 } }), { expiry: nowSec() + 3600 }));
  const { secret } = await register(deps);
  const takeover = await register(deps, { secret, signer: otherAgent, agentName: `codex.${OTHER_MEMBER}`, memberName: OTHER_MEMBER });
  assert.equal(takeover.res.status, 409);
  assert.equal(deps.sessions.get(loginSecretHash(secret), nowSec())?.agent, AGENT, "still the first login");
  // The same key signing the same login again (a retried request) is fine.
  assert.equal((await register(deps, { secret })).res.status, 201);
});

test("a failed save fails only that request: logins keep working and the next change saves", async () => {
  const { deps } = setup();
  const dir = fs.mkdtempSync(path.join(path.dirname(deps.sessions.file), "sessions-"));
  const store = { ...deps, sessions: new CodexSessionStore(path.join(dir, "codex-sessions.json")) };
  const first = await register(store);
  assert.equal(first.res.status, 201);
  fs.chmodSync(dir, 0o500);
  try {
    const failed = await register(store);
    assert.equal(failed.res.status, 503, JSON.stringify(failed.json));
    assert.equal(Object.keys(store.sessions.data.sessions).length, 1, "rolled back");
    assert.equal((await codexCall(store, first.secret, MEMBER)).status, 200, "the saved login still works");
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.equal((await register(store)).res.status, 201);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(store.sessions.file, "utf8")).sessions).length, 2);
});

test("a damaged store fails closed and is never saved over", async () => {
  const { deps } = setup();
  fs.writeFileSync(deps.sessions.file, "{not json");
  const broken = { ...deps, sessions: new CodexSessionStore(deps.sessions.file) };
  const { res, json } = await register(broken);
  assert.equal(res.status, 503, JSON.stringify(json));
  assert.equal(fs.readFileSync(deps.sessions.file, "utf8"), "{not json");
  assert.equal((await codexCall(broken, newLoginSecret(), MEMBER)).status, 503);
});

// --- The login route ------------------------------------------------------------------------------

test("the member's ENS name as the API key runs the call as the agent, with the OpenAI key added upstream", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const before = up.seen.length;
  const r = await codexCall(deps, secret, MEMBER);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.text.includes("response.completed"));
  const seen = up.seen[before];
  assert.equal(seen.url, "/v1/responses");
  assert.equal(seen.headers.authorization, `Bearer ${OPENAI_KEY}`, "the typed name never reaches OpenAI");
  assert.equal(seen.headers["x-relay-login"], undefined, "nor does the secret");
  const log = deps.meter.recent(10).find((e) => e.allowed);
  assert.equal(log?.name, AGENT);
  assert.equal(log?.path, "/v1/responses", "the log never holds the secret");
  // The agent's name works too, in any case and with stray spaces.
  assert.equal((await codexCall(deps, secret, ` ${AGENT.toUpperCase()} `)).status, 200);
  // Never a secret in the URL: /api/relay/codex/s/<secret>/… is no login route.
  const inPath = await handleCodexSessionRequest(
    new Request(`${RELAY}/api/relay/codex/s/${secret}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${MEMBER}` }, body: RESPONSES_BODY }),
    deps,
  );
  assert.equal(inPath.status, 401);
  // Dot segments can't climb out of the codex provider (the URL parser resolves them, and it is no login URL then).
  const seenBefore = up.seen.length;
  assert.equal((await codexCall(deps, secret, MEMBER, { p: "/v1/../../../claude/v1/messages" })).status, 401);
  assert.equal(up.seen.length, seenBefore);
});

test("a wrong name, no name, an unknown, expired or revoked login are refused with what to do", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const wrong = await codexCall(deps, secret, "nina.eng.acme.eth");
  assert.equal(wrong.status, 401);
  assert.match(wrong.message, /This login is for derek\.eng\.acme\.eth/);
  const none = await codexCall(deps, secret, null);
  assert.equal(none.status, 401);
  assert.match(none.message, /Provide your own API key.*derek\.eng\.acme\.eth/);
  const unknown = await codexCall(deps, newLoginSecret(), MEMBER);
  assert.equal(unknown.status, 401);
  assert.match(unknown.message, /expired or was revoked\. Run relay login again/);
  assert.equal((await codexCall(deps, "not-a-secret", MEMBER)).status, 401);
  assert.equal((await codexCall(deps, "", MEMBER)).status, 401, "no x-relay-login header");

  const expiring = await register(deps, { exp: nowSec() + 60 });
  const later = { ...deps, now: () => new Date(Date.now() + 120_000) };
  assert.match((await codexCall(later, expiring.secret, MEMBER)).message, /expired or was revoked/);

  await revoke(deps, secret);
  assert.match((await codexCall(deps, secret, MEMBER)).message, /expired or was revoked/);
  assert.equal(up.seen.filter((s) => s.headers.authorization === `Bearer ${MEMBER}`).length, 0);
});

test("failed logins share the failure budget: a guessing client is rate limited", async () => {
  const { deps } = setup();
  let last = 0;
  for (let i = 0; i < 40 && last !== 429; i++) last = (await codexCall(deps, newLoginSecret(), MEMBER)).status;
  assert.equal(last, 429);
});

test("removing the member on ENS revokes the login's access; so does a new agent owner", async () => {
  const { deps, chain } = setup();
  const { secret } = await register(deps);
  assert.equal((await codexCall(deps, secret, MEMBER)).status, 200);
  chain.remove(MEMBER);
  const revoked = await codexCall(deps, secret, MEMBER);
  assert.equal(revoked.status, 403);
  assert.match(revoked.message, /access revoked: derek\.eng\.acme\.eth was removed or expired/);
  chain.restore(MEMBER);
  chain.levels[3] = { ...chain.levels[3], owner: stranger.address };
  const moved = await codexCall(deps, secret, MEMBER);
  assert.equal(moved.status, 401);
});

test("relay.nbf on the agent refuses logins made before it", async () => {
  const { deps, chain } = setup();
  const { secret } = await register(deps, { iat: nowSec() - 60 });
  chain.levels[3] = { ...chain.levels[3], nbf: nowSec() };
  const r = await codexCall(deps, secret, MEMBER);
  assert.equal(r.status, 401);
  assert.match(r.message, /issued before/);
});

// --- Usage-limit headers ------------------------------------------------------------------------

test("codex answers carry the binding cap as Codex's usage headers, replacing upstream ones", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const d = await decide({ name: AGENT, provider: "codex", signer: agent.address }, deps);
  charge(d.levels, "codex", 0.8, deps.meter);
  const r = await codexCall(deps, secret, MEMBER);
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get("x-codex-primary-used-percent"), "80", "the agent's $1 total cap is 80% used");
  assert.equal(r.res.headers.get("x-codex-primary-window-minutes"), null, "a one-off cap has no window");
  const expiry = d.levels[3].expiry!;
  assert.equal(r.res.headers.get("x-codex-primary-reset-at"), String(expiry), "a total cap 'resets' when the agent's name expires");
  assert.equal(r.res.headers.get("x-codex-credits-has-credits"), null);
  assert.equal(r.res.headers.get("x-codex-limit-name"), null);

  // The kr1 route gets them too.
  const kr1 = await relayJson(deps, "codex", "/v1/responses", { kr: await tokenFor(agent, AGENT), body: JSON.parse(RESPONSES_BODY) });
  assert.equal(kr1.status, 200);
  assert.ok(Number(kr1.res.headers.get("x-codex-primary-used-percent")) >= 80);
});

test("a daily cap sends the daily window and the next UTC midnight; the tightest level wins", async () => {
  const { deps } = setup({ agentBundle: bundle("codex", { caps: { codex: 10 }, period: "day" }) });
  const d = await decide({ name: AGENT, provider: "codex", signer: agent.address }, deps);
  const now = new Date("2026-09-27T15:00:00Z");
  // The member ($2 a month) has $0.50 left; the agent ($10 a day) has $9.
  charge(d.levels.slice(2), "codex", 1.0, deps.meter, now);
  charge(d.levels.slice(2, 3), "codex", 0.5, deps.meter, now);
  const u = codexCapUsage(d, deps.meter, now)!;
  assert.equal(u.name, MEMBER);
  assert.equal(usedPercent(u), 75);
  assert.equal(u.windowMinutes, 43200);
  assert.equal(u.resetAt, Date.UTC(2026, 9, 1) / 1000);
  assert.equal(u.raiser, "eng.acme.eth");
  charge(d.levels.slice(3), "codex", 8.9, deps.meter, now);
  const agentWins = codexCapUsage(d, deps.meter, now)!;
  assert.equal(agentWins.name, AGENT);
  assert.deepEqual(codexLimitHeaders(agentWins, now.getTime() / 1000), {
    "x-codex-primary-used-percent": "99",
    "x-codex-primary-window-minutes": "1440",
    "x-codex-primary-reset-at": String(Date.UTC(2026, 8, 28) / 1000),
  });
});

test("a spent cap is a 429 usage_limit_reached with the promo text on a login, and still a 403 on kr1", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const d = await decide({ name: AGENT, provider: "codex", signer: agent.address }, deps);
  charge(d.levels, "codex", 1, deps.meter);
  const before = up.seen.length;
  const r = await codexCall(deps, secret, MEMBER);
  assert.equal(r.status, 429);
  assert.equal(r.json?.error?.type, "usage_limit_reached");
  assert.equal(r.json?.error?.resets_at, d.levels[3].expiry);
  assert.equal(r.res.headers.get("x-codex-primary-used-percent"), "100");
  assert.equal(
    r.res.headers.get("x-codex-promo-message"),
    `${AGENT} has used its $1.00 Codex cap. Ask ${MEMBER} to raise it`,
  );
  assert.equal(up.seen.length, before, "nothing reached OpenAI");
  const log = deps.meter.recent(10)[0];
  assert.equal(log.allowed, false);
  assert.match(log.reason ?? "", /has used its codex cap/);

  const kr1 = await relayJson(deps, "codex", "/v1/responses", { kr: await tokenFor(agent, AGENT), body: JSON.parse(RESPONSES_BODY) });
  assert.equal(kr1.status, 403);
  assert.match(kr1.reason ?? "", /has used its codex cap/);
});

test("a budget too small for the next call is also a usage limit on a login", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const d = await decide({ name: AGENT, provider: "codex", signer: agent.address }, deps);
  charge(d.levels, "codex", 0.99999, deps.meter);
  const r = await codexCall(deps, secret, MEMBER);
  assert.equal(r.status, 429, r.text);
  assert.equal(r.res.headers.get("x-codex-promo-message"), `${AGENT} has used its $1.00 Codex cap. Ask ${MEMBER} to raise it`);
  assert.equal(usagePromo({ ...codexCapUsage(d, deps.meter, new Date())!, spent: 0.97 }, "x"), `${AGENT} has $0.03 of its $1.00 Codex cap left, too little for another call. Ask ${MEMBER} to raise it`);
});

test("a budget held by calls still running says so, and names the level they squeeze", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const d = await decide({ name: AGENT, provider: "codex", signer: agent.address }, deps);
  const now = new Date();
  charge(d.levels, "codex", 0.2, deps.meter, now);
  // Another of the member's agents has a call running that holds $1.799 of the member's $2: the member
  // ($0.001 free) stops this agent before its own $1 cap ($0.80 free) does.
  const sibling = reserve(d.levels.slice(0, 3), "codex", 1.799, deps.meter, now);
  assert.ok(sibling.ok);
  const u = codexCapUsage(d, deps.meter, now, "held")!;
  assert.equal(u.name, MEMBER);
  assert.equal(u.held, 1.799);
  assert.equal(usedPercent(u), 10, "the used percent counts only settled spend");
  assert.equal(usagePromo(u, "x"), `${MEMBER} has $1.80 of its $2.00 Codex cap left, but calls still running hold $1.80 of it until they finish. Ask eng.acme.eth to raise it`);
  // Codex's display stays on settled spend: the agent's own cap, 20% used, while that call runs.
  const shown = codexCapUsage(d, deps.meter, now)!;
  assert.equal(shown.name, AGENT);
  assert.equal(usedPercent(shown), 20);
  const refused = await codexCall(deps, secret, MEMBER);
  assert.equal(refused.status, 429, refused.text);
  assert.equal(refused.res.headers.get("x-codex-promo-message"), usagePromo(u, "x"), "the refusal names the member, whose holds refused it");
  assert.equal(refused.res.headers.get("x-codex-primary-used-percent"), "10");
  assert.equal(refused.res.headers.get("x-codex-primary-window-minutes"), "43200", "the member's monthly cap");
  sibling.reservation.settle(0.01);
  const settled = codexCapUsage(d, deps.meter, now, "held")!;
  assert.equal(settled.name, AGENT);
  assert.equal(settled.held, 0);

  // The agent's own running call holding nearly all it has left: Codex's next call is a usage limit that says why.
  const running = reserve(d.levels, "codex", 0.798, deps.meter, now);
  assert.ok(running.ok);
  const r = await codexCall(deps, secret, MEMBER);
  assert.equal(r.status, 429, r.text);
  assert.equal(
    r.res.headers.get("x-codex-promo-message"),
    `${AGENT} has $0.80 of its $1.00 Codex cap left, but calls still running hold $0.80 of it until they finish. Ask ${MEMBER} to raise it`,
  );
  // It frees up when that call ends, not at the cap's reset: no resets_at ("or try again later"), and the real 20% used.
  assert.equal(r.json?.error?.type, "usage_limit_reached");
  assert.equal(r.json?.error?.resets_at, undefined);
  assert.equal(r.res.headers.get("x-codex-primary-used-percent"), "20");
  assert.equal(r.res.headers.get("x-codex-primary-reset-at"), String(d.levels[3].expiry), "the footer still shows when the cap itself resets");
  running.reservation.settle(0.02);
  assert.equal((await codexCall(deps, secret, MEMBER)).status, 200, "free again once it ends");
});

test("a refusal reads the holds when it refuses, not when the call arrived", async () => {
  const { deps } = setup();
  const { secret } = await register(deps);
  const d = await decide({ name: AGENT, provider: "codex", signer: agent.address }, deps);
  const now = new Date();
  charge(d.levels, "codex", 0.2, deps.meter, now);
  // Codex sends a turn and a title request together: the other one reserves while this one's body is read.
  let reading!: () => void;
  const read = new Promise<void>((r) => (reading = r));
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        reading();
        await released;
        c.enqueue(new TextEncoder().encode(RESPONSES_BODY));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  const headers = { "content-type": "application/json", authorization: `Bearer ${MEMBER}`, "x-relay-login": secret };
  const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body, duplex: "half" };
  const answer = handleCodexSessionRequest(new Request(`${RELAY}/api/relay/codex/login/v1/responses`, init), deps);
  await read;
  const other = reserve(d.levels, "codex", 0.799, deps.meter, now);
  assert.ok(other.ok);
  release();
  const res = await answer;
  assert.equal(res.status, 429, await res.clone().text());
  assert.equal(
    res.headers.get("x-codex-promo-message"),
    `${AGENT} has $0.80 of its $1.00 Codex cap left, but calls still running hold $0.80 of it until they finish. Ask ${MEMBER} to raise it`,
  );
  other.reservation.settle(0.01);
});

test("secret hashes are lowercase 0x sha256 hex, and secrets are 43 base64url characters", () => {
  const s = newLoginSecret();
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.match(loginSecretHash(s), /^0x[0-9a-f]{64}$/);
  assert.notEqual(newLoginSecret(), s);
  assert.equal(loginSecretHash("abc") as Hex, "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
