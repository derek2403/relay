// Admin sign-in with the root owner's wallet (lib/relay/admin-wallet.ts): the challenge names
// this relay, its root, the wallet, a single-use nonce and a 5-minute expiry; the verify step
// refuses a wrong signer, a wallet that isn't the on-chain owner (now), an expired or replayed
// nonce and a message for another origin or root; failures spend the failure budget; admin
// sign-in off answers a clear refusal; success sets exactly the token sign-in's cookie.

import assert from "node:assert/strict";
import test from "node:test";

import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { type AdminWalletDeps, adminStatement, getAdminChallenge, postAdminWallet, verifyAdminSignIn } from "./admin-wallet";
import { ADMIN_COOKIE, ADMIN_SESSION_SEC, isAdmin, viewerFor } from "./auth";
import { loadConfig } from "./config";
import type { NonceResponse } from "./credentials-types";
import { Meter } from "./meter";
import { NONCE_TTL_MS, NonceStore, ownerMessage, verifyEoaSignature } from "./owner-session";
import { ClientLimit, createLimits } from "./ratelimit";
import { MemoryChain, level, tempDir } from "./testkit";

const ORIGIN = "http://127.0.0.1:3000";
const TOKEN = "admin-token-for-wallet-test-0123456789";
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

type Env = Record<string, string | undefined>;

function setup(env: Env = {}) {
  const chain = new MemoryChain([level("acme.eth", owner.address, null)]);
  const clock = { now: 1_800_000_000_000 };
  const deps: AdminWalletDeps = {
    config: loadConfig({ RELAY_ROOT_NAME: "acme.eth", RELAY_PUBLIC_URL: ORIGIN, RELAY_ADMIN_TOKEN: TOKEN, ...env }),
    reader: chain,
    limits: createLimits(),
    nonces: new NonceStore(),
    nonceLimit: new ClientLimit([1000, 10], [1000, 10]),
    verify: verifyEoaSignature,
    now: () => clock.now,
  };
  return { deps, chain, clock };
}

const challengeReq = (address: string, url = ORIGIN) => new Request(`${url}/api/relay/admin/wallet?address=${address}`);

const signInReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/relay/admin/wallet`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });

async function challenge(deps: AdminWalletDeps, address: Address = owner.address) {
  const res = await getAdminChallenge(challengeReq(address), deps);
  assert.equal(res.status, 200);
  return (await res.json()) as NonceResponse;
}

async function signIn(deps: AdminWalletDeps, account = owner, message?: string) {
  const text = message ?? (await challenge(deps, account.address)).message;
  const signature = await account.signMessage({ message: text });
  return postAdminWallet(signInReq({ address: account.address, message: text, signature }), deps);
}

const reasonOf = async (res: Response) => ((await res.json()) as { reason: string }).reason;

test("the challenge is a plain EIP-4361 message naming this relay, the root, the wallet, a nonce and a 5-minute expiry", async () => {
  const { deps } = setup();
  const n = await challenge(deps);
  assert.match(n.message, /^127\.0\.0\.1:3000 wants you to sign in with your Ethereum account:\n/);
  assert.ok(n.message.includes(`\n${owner.address}\n`), "the checksummed wallet address");
  assert.ok(n.message.includes(adminStatement("acme.eth")));
  assert.match(n.message, /Sign in as the admin of the relay for acme\.eth/);
  assert.match(n.message, /\nURI: http:\/\/127\.0\.0\.1:3000\n/);
  assert.ok(n.message.includes(`\nNonce: ${n.nonce}\n`));
  assert.match(n.nonce, /^[0-9a-f]{32}$/);
  assert.equal(n.expiresAt, deps.now!() + NONCE_TTL_MS);
  assert.ok(NONCE_TTL_MS <= 5 * 60_000);
  assert.match(n.message, new RegExp(`Expiration Time: ${new Date(n.expiresAt).toISOString().replace(/\./g, "\\.")}`));
  // Lower-case input is fine; anything else isn't an address.
  assert.equal((await getAdminChallenge(challengeReq(owner.address.toLowerCase()), deps)).status, 200);
  assert.equal((await getAdminChallenge(challengeReq("nope"), deps)).status, 400);
  // Two challenges, two nonces.
  assert.notEqual((await challenge(deps)).nonce, n.nonce);
});

test("a wallet that doesn't own the root is refused before it is asked to sign", async () => {
  const { deps } = setup();
  const res = await getAdminChallenge(challengeReq(stranger.address), deps);
  assert.equal(res.status, 403);
  assert.match(await reasonOf(res), /doesn't own acme\.eth/);
  assert.equal(deps.nonces.size, 0, "no nonce issued");
  const pinned = setup({ RELAY_ROOT_OWNER: stranger.address });
  const res2 = await getAdminChallenge(challengeReq(owner.address), pinned.deps);
  assert.equal(res2.status, 403);
  assert.match(await reasonOf(res2), /RELAY_ROOT_OWNER/);

  // The refusal spends a failure: with one left, the next challenge is a 429 (no chain read).
  const last = setup();
  for (let i = 0; i < 29; i++) last.deps.limits.failures.spend("direct");
  assert.equal((await getAdminChallenge(challengeReq(stranger.address), last.deps)).status, 403);
  last.deps.reader = { readLevels: async () => assert.fail("no chain read once the failures are spent") };
  const limited = await getAdminChallenge(challengeReq(owner.address), last.deps);
  assert.equal(limited.status, 429);
  assert.equal(last.deps.nonces.size, 0);
});

test("the root owner signs in: the same HttpOnly SameSite=Strict admin cookie the token sign-in sets, for a week", async () => {
  const { deps } = setup();
  const res = await signIn(deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { admin: true, address: owner.address });
  const setCookie = res.headers.get("set-cookie")!;
  assert.equal(setCookie, `${ADMIN_COOKIE}=${deps.config.admin.cookie()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_SESSION_SEC}`);
  assert.equal(ADMIN_SESSION_SEC, 7 * 24 * 3600);
  assert.ok(!setCookie.includes(TOKEN), "the cookie is not the token");

  // Every existing admin check accepts it.
  const cookie = setCookie.split(";")[0];
  const read = new Request(`${ORIGIN}/api/relay/log`, { headers: { cookie } });
  assert.ok(isAdmin(read, deps));
  const meter = new Meter(`${tempDir()}/relay.json`, 5);
  assert.deepEqual(await viewerFor(read, { config: deps.config, reader: deps.reader, meter }, createLimits()), { kind: "admin" });
});

test("the token sign-in and the wallet sign-in set byte-identical cookies", async (t) => {
  const saved = { RELAY_ROOT_NAME: process.env.RELAY_ROOT_NAME, RELAY_PUBLIC_URL: process.env.RELAY_PUBLIC_URL, RELAY_ADMIN_TOKEN: process.env.RELAY_ADMIN_TOKEN };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.RELAY_ROOT_NAME = "acme.eth";
  process.env.RELAY_PUBLIC_URL = ORIGIN;
  process.env.RELAY_ADMIN_TOKEN = TOKEN;
  const { POST } = await import("../../app/api/relay/admin/route");
  const form = new FormData();
  form.set("token", TOKEN);
  const byToken = await POST(new Request(`${ORIGIN}/api/relay/admin`, { method: "POST", body: form }) as never);
  assert.equal(byToken.status, 303);
  const byWallet = await signIn(setup().deps);
  assert.equal(byWallet.headers.get("set-cookie"), byToken.headers.get("set-cookie"));

  // Behind https both add Secure.
  const httpsForm = new FormData();
  httpsForm.set("token", TOKEN);
  const secureToken = await POST(new Request(`${ORIGIN}/api/relay/admin`, { method: "POST", body: httpsForm, headers: { "x-forwarded-proto": "https" } }) as never);
  const { deps } = setup();
  const { message } = await challenge(deps);
  const signature = await owner.signMessage({ message });
  const secureWallet = await postAdminWallet(signInReq({ address: owner.address, message, signature }, { "x-forwarded-proto": "https" }), deps);
  assert.match(secureWallet.headers.get("set-cookie")!, /; Secure$/);
  assert.equal(secureWallet.headers.get("set-cookie"), secureToken.headers.get("set-cookie"));
});

test("a signature from another wallet is refused", async () => {
  const { deps } = setup();
  const { message } = await challenge(deps);
  const signature = await stranger.signMessage({ message });
  const res = await postAdminWallet(signInReq({ address: owner.address, message, signature }), deps);
  assert.equal(res.status, 401);
  assert.match(await reasonOf(res), /signature doesn't match/);
  assert.equal(res.headers.get("set-cookie"), null);
});

test("the signer must own the root on-chain at verify time", async () => {
  const { deps, chain } = setup();
  const { message } = await challenge(deps);
  const signature = await owner.signMessage({ message });
  // The root changed hands after the challenge.
  chain.levels[0] = level("acme.eth", stranger.address, null);
  const res = await postAdminWallet(signInReq({ address: owner.address, message, signature }), deps);
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, "not the owner");
  assert.equal(res.headers.get("set-cookie"), null);

  // A root that isn't registered has no owner to sign in.
  const gone = setup();
  const n = await challenge(gone.deps);
  const sig = await owner.signMessage({ message: n.message });
  gone.chain.remove("acme.eth");
  const res2 = await postAdminWallet(signInReq({ address: owner.address, message: n.message, signature: sig }), gone.deps);
  assert.equal(res2.status, 401);
  assert.match(await reasonOf(res2), /not registered/);
});

test("nonces are single use and expire after 5 minutes", async () => {
  const { deps, clock } = setup();
  const { message } = await challenge(deps);
  const signature = await owner.signMessage({ message });
  const send = () => postAdminWallet(signInReq({ address: owner.address, message, signature }), deps);
  assert.equal((await send()).status, 200);
  const replay = await send();
  assert.equal(replay.status, 401);
  assert.match(await reasonOf(replay), /expired or was already used/);
  assert.equal(replay.headers.get("set-cookie"), null);

  const late = await challenge(deps);
  const lateSig = await owner.signMessage({ message: late.message });
  clock.now += NONCE_TTL_MS + 1;
  const expired = await postAdminWallet(signInReq({ address: owner.address, message: late.message, signature: lateSig }), deps);
  assert.equal(expired.status, 401);
  assert.match(await reasonOf(expired), /expired or was already used/);
});

test("the same signed message sent twice at once signs in once", async () => {
  const { deps } = setup();
  const { message } = await challenge(deps);
  const signature = await owner.signMessage({ message });
  const send = () => postAdminWallet(signInReq({ address: owner.address, message, signature }), deps);
  const results = await Promise.all([send(), send(), send()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
  assert.equal(results.filter((r) => r.headers.get("set-cookie")).length, 1);
});

test("the message names the host the page addressed when it is this relay, never a host the caller picks", async () => {
  // Next hands route handlers http://localhost:<port> while the page may run on 127.0.0.1:<port>.
  const { deps } = setup();
  const ask = async (host: string) => {
    const res = await getAdminChallenge(new Request(`http://localhost:3000/api/relay/admin/wallet?address=${owner.address}`, { headers: { host } }), deps);
    assert.equal(res.status, 200);
    return ((await res.json()) as NonceResponse).message;
  };
  assert.match(await ask("127.0.0.1:3000"), /^127\.0\.0\.1:3000 wants you to sign in[^]*\nURI: http:\/\/127\.0\.0\.1:3000\n/);
  assert.match(await ask("localhost:3000"), /^localhost:3000 wants you to sign in/);
  assert.match(await ask("evil.example"), /^localhost:3000 wants you to sign in/);

  // Behind a proxy: the public name, as RELAY_PUBLIC_URL spells it.
  const pub = setup({ RELAY_PUBLIC_URL: "https://relay.acme.test" });
  const res = await getAdminChallenge(
    new Request(`http://0.0.0.0:3000/api/relay/admin/wallet?address=${owner.address}`, { headers: { host: "relay.acme.test", "x-forwarded-proto": "https" } }),
    pub.deps,
  );
  const { message } = (await res.json()) as NonceResponse;
  assert.match(message, /^relay\.acme\.test wants you to sign in[^]*\nURI: https:\/\/relay\.acme\.test\n/);
  const signature = await owner.signMessage({ message });
  const post = (headers: Record<string, string>) =>
    postAdminWallet(
      new Request("http://0.0.0.0:3000/api/relay/admin/wallet", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://relay.acme.test", ...headers },
        body: JSON.stringify({ address: owner.address, message, signature }),
      }),
      pub.deps,
    );
  // Sent to the relay under another host, it names another site than the one it's used on.
  const elsewhere = await post({ host: "0.0.0.0:3000" });
  assert.equal(elsewhere.status, 401);
  assert.match(await reasonOf(elsewhere), /signs in to relay\.acme\.test, not 0\.0\.0\.0:3000/);
  // Its nonce went with it; a new challenge on the right host signs in (Secure behind https).
  const burned = await post({ host: "relay.acme.test" });
  assert.equal(burned.status, 401);
  assert.match(await reasonOf(burned), /expired or was already used/);
  const again = await getAdminChallenge(
    new Request(`http://0.0.0.0:3000/api/relay/admin/wallet?address=${owner.address}`, { headers: { host: "relay.acme.test" } }),
    pub.deps,
  );
  const fresh = ((await again.json()) as NonceResponse).message;
  const ok = await postAdminWallet(
    new Request("http://0.0.0.0:3000/api/relay/admin/wallet", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://relay.acme.test", host: "relay.acme.test", "x-forwarded-proto": "https" },
      body: JSON.stringify({ address: owner.address, message: fresh, signature: await owner.signMessage({ message: fresh }) }),
    }),
    pub.deps,
  );
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie")!, /; Secure$/);
});

test("a message for another origin or another root is refused, and its nonce is burned", async () => {
  const { deps } = setup();
  const origin = new URL(ORIGIN);
  const verify = (message: string, signature: `0x${string}`, at = origin) =>
    verifyAdminSignIn({ address: owner.address, message, signature }, at, { ...deps, now: deps.now!() });

  // Edited to name another site: the signature covers the edit, the origin doesn't match.
  {
    const { message } = await challenge(deps);
    const edited = message.replace("127.0.0.1:3000 wants", "evil.example wants").replace("URI: http://127.0.0.1:3000", "URI: https://evil.example");
    const r = await verify(edited, await owner.signMessage({ message: edited }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /signs in to evil\.example, not 127\.0\.0\.1:3000/);
    // The original can't be used afterwards either.
    const again = await verify(message, await owner.signMessage({ message }));
    assert.equal(again.ok, false);
    assert.match(!again.ok ? again.reason : "", /expired or was already used/);
  }
  // Issued here but sent to another origin of the relay.
  {
    const { message } = await challenge(deps);
    const r = await verify(message, await owner.signMessage({ message }), new URL("https://relay.acme.test"));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /not relay\.acme\.test/);
  }
  // Another company's root, or the relay's root changed since the challenge.
  {
    const { message } = await challenge(deps);
    const other = message.replace("relay for acme.eth", "relay for other.eth");
    const r = await verify(other, await owner.signMessage({ message: other }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /isn't an admin sign-in for acme\.eth/);

    const n = await challenge(deps);
    const moved = { ...deps, config: loadConfig({ RELAY_ROOT_NAME: "other.eth", RELAY_PUBLIC_URL: ORIGIN, RELAY_ADMIN_TOKEN: TOKEN }) };
    const r2 = await verifyAdminSignIn({ address: owner.address, message: n.message, signature: await owner.signMessage({ message: n.message }) }, origin, { ...moved, now: deps.now!() });
    assert.equal(r2.ok, false);
    assert.match(!r2.ok ? r2.reason : "", /isn't an admin sign-in for other\.eth/);
  }
  // The credentials sign-in's message (same wallet, same format) doesn't sign in as admin.
  {
    const nonce = deps.nonces.issue(owner.address, (nonce, issuedAt, expiresAt) =>
      ownerMessage({ domain: origin.host, uri: origin.origin, address: owner.address, root: "acme.eth", nonce, issuedAt, expiresAt }),
    );
    const r = await verify(nonce.message, await owner.signMessage({ message: nonce.message }));
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /isn't an admin sign-in/);
  }
  // Not a sign-in message at all.
  const junk = await verify("hello", await owner.signMessage({ message: "hello" }));
  assert.equal(junk.ok, false);
  assert.equal((await postAdminWallet(signInReq({ address: owner.address, message: 42, signature: "0x00" }), deps)).status, 400);
});

test("failed sign-ins spend the failure budget (429 when empty)", async () => {
  // The per-client budget is 30: 29 other failures leave room for one more sign-in...
  const room = setup();
  for (let i = 0; i < 29; i++) room.deps.limits.failures.spend("direct");
  assert.equal((await signIn(room.deps)).status, 200);

  // ...unless a refused sign-in took it: then even a good signature waits, and so do new challenges.
  const { deps } = setup();
  for (let i = 0; i < 29; i++) deps.limits.failures.spend("direct");
  const { message } = await challenge(deps);
  const good = await challenge(deps);
  const bad = await postAdminWallet(signInReq({ address: owner.address, message, signature: await stranger.signMessage({ message }) }), deps);
  assert.equal(bad.status, 401);
  const res = await signIn(deps, owner, good.message);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal((await getAdminChallenge(challengeReq(owner.address), deps)).status, 429);
});

test("admin sign-in off (no RELAY_ADMIN_TOKEN): a clear refusal, and open / closed relays stay as they are", async () => {
  for (const [env, mode, reason] of [
    [{ RELAY_ADMIN_TOKEN: "" }, "open", /shows spend and its log to anyone/],
    [{ RELAY_ADMIN_TOKEN: "", NODE_ENV: "production" }, "closed", /nobody can sign in as admin/],
  ] as const) {
    const { deps } = setup(env);
    assert.equal(deps.config.viewAuth, mode);
    const get = await getAdminChallenge(challengeReq(owner.address), deps);
    assert.equal(get.status, 404);
    const body = (await get.json()) as { error: string; reason: string };
    assert.equal(body.error, "admin sign-in is off");
    assert.match(body.reason, reason);
    const post = await postAdminWallet(signInReq({ address: owner.address, message: "x", signature: "0x00" }), deps);
    assert.equal(post.status, 404);
    assert.equal(post.headers.get("set-cookie"), null);
    assert.equal(deps.nonces.size, 0);
  }
  // No company root: nobody to own it.
  const { deps } = setup({ RELAY_ROOT_NAME: "" });
  assert.equal((await getAdminChallenge(challengeReq(owner.address), deps)).status, 503);
});

test("the sign-in POST is same-origin JSON only", async () => {
  const { deps } = setup();
  const { message } = await challenge(deps);
  const signature = await owner.signMessage({ message });
  const body = { address: owner.address, message, signature };
  assert.equal((await postAdminWallet(signInReq(body, { origin: "https://evil.example" }), deps)).status, 403);
  assert.equal((await postAdminWallet(signInReq(body, { "content-type": "text/plain" }), deps)).status, 415);
  assert.equal((await postAdminWallet(signInReq(body, { "sec-fetch-site": "cross-site" }), deps)).status, 403);
  // Refused before the nonce was looked at: it still works from the page.
  assert.equal((await postAdminWallet(signInReq(body), deps)).status, 200);
});

test("a chain outage is a 502, not a spent failure", async () => {
  const { deps, chain } = setup();
  for (let i = 0; i < 29; i++) deps.limits.failures.spend("direct");
  const { message } = await challenge(deps);
  const signature = await owner.signMessage({ message });
  const { ChainReadError } = await import("./ens");
  deps.reader = { readLevels: async () => Promise.reject(new ChainReadError("rate limited")) };
  const res = await postAdminWallet(signInReq({ address: owner.address, message, signature }), deps);
  assert.equal(res.status, 502);
  assert.equal((await getAdminChallenge(challengeReq(owner.address), deps)).status, 502);
  // The last token of the failure budget is still there once the chain answers again.
  deps.reader = chain;
  assert.equal((await signIn(deps)).status, 200);
});
