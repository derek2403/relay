import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { loadConfig } from "./config";
import { CredentialStore, EnvBinding } from "./credentials";
import { type CredentialsDeps, createCustom, getCredentials, getNonce, postSession, writeCustom, writeKey } from "./credentials-api";
import type { CredentialsResponse, NonceResponse } from "./credentials-types";
import {
  NONCE_TTL_MS,
  NonceStore,
  OWNER_COOKIE,
  SESSION_TTL_MS,
  csrfProblem,
  readSession,
  sessionToken,
  verifyEoaSignature,
} from "./owner-session";
import { ClientLimit, createLimits } from "./ratelimit";
import { MemoryChain, level, tempDir } from "./testkit";

const SECRET = "c".repeat(64);
const ORIGIN = "http://127.0.0.1:3000";
const owner = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

type Env = Record<string, string | undefined>;

function setup(opts: { env?: Env; rootOwner?: Address | null } = {}) {
  const dir = tempDir();
  const env: Env = { RELAY_ROOT_NAME: "acme.eth", RELAY_DATA_DIR: dir, RELAY_SECRET: SECRET, RELAY_PUBLIC_URL: ORIGIN, ...opts.env };
  const store = new CredentialStore(path.join(dir, "credentials.json"), env.RELAY_SECRET);
  const binding = new EnvBinding();
  binding.apply(env, store.desiredEnv());
  const chain = new MemoryChain([level("acme.eth", opts.rootOwner === undefined ? owner.address : opts.rootOwner, null)]);
  const clock = { now: 1_800_000_000_000 };
  const deps: CredentialsDeps = {
    config: loadConfig(env),
    reader: chain,
    env,
    runtime: { store, binding },
    limits: createLimits(),
    nonces: new NonceStore(),
    verify: verifyEoaSignature,
    now: () => clock.now,
  };
  return { deps, env, chain, clock, store };
}

const req = (p: string, init: RequestInit & { cookie?: string; origin?: string | null; json?: boolean } = {}) => {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.json !== false && init.method && init.method !== "GET") headers["content-type"] = "application/json";
  if (init.origin !== null && init.method && init.method !== "GET") headers.origin = init.origin ?? ORIGIN;
  if (init.cookie) headers.cookie = init.cookie;
  return new Request(`${ORIGIN}${p}`, { method: init.method ?? "GET", headers, body: init.body });
};

async function nonceFor(deps: CredentialsDeps, address: Address) {
  const res = getNonce(req(`/api/relay/credentials/nonce?address=${address}`), deps);
  assert.equal(res.status, 200);
  return (await res.json()) as NonceResponse;
}

async function signIn(deps: CredentialsDeps, account = owner, tamper?: (m: string) => string) {
  const { message } = await nonceFor(deps, account.address);
  const signature = await account.signMessage({ message });
  return postSession(
    req("/api/relay/credentials/session", { method: "POST", body: JSON.stringify({ address: account.address, message: tamper ? tamper(message) : message, signature }) }),
    deps,
  );
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0];

test("the nonce message is an EIP-4361 sign-in for this relay and root", async () => {
  const { deps } = setup();
  const n = await nonceFor(deps, owner.address);
  assert.match(n.message, /^127\.0\.0\.1:3000 wants you to sign in with your Ethereum account:\n0x/);
  assert.match(n.message, /acme\.eth/);
  assert.match(n.message, new RegExp(`Nonce: ${n.nonce}`));
  assert.match(n.message, /Chain ID: 11155111/);
  assert.equal(n.expiresAt, deps.now!() + NONCE_TTL_MS);
  assert.equal(getNonce(req("/api/relay/credentials/nonce?address=nope"), deps).status, 400);
});

test("the sign-in domain is the host the browser addressed when it is this relay, never an arbitrary Host", async () => {
  const { deps } = setup({ env: { RELAY_PUBLIC_URL: "https://relay.acme.test" } });
  // Next gives route handlers http://localhost:<port> while the page runs on 127.0.0.1:<port>.
  const ask = async (host: string) => {
    // Its own limit, so these don't use up the shared per-client nonce budget of the other tests.
    const res = getNonce(new Request(`http://localhost:3100/api/relay/credentials/nonce?address=${owner.address}`, { headers: { host } }), deps, new ClientLimit([20, 0.5], [300, 5]));
    return ((await res.json()) as NonceResponse).message;
  };
  assert.match(await ask("127.0.0.1:3100"), /^127\.0\.0\.1:3100 wants you to sign in[^]*\nURI: http:\/\/127\.0\.0\.1:3100\n/);
  assert.match(await ask("relay.acme.test"), /^relay\.acme\.test wants you to sign in[^]*\nURI: https:\/\/relay\.acme\.test\n/);
  assert.match(await ask("evil.example"), /^localhost:3100 wants you to sign in/);
});

test("the root owner signs in: HttpOnly SameSite=Strict cookie for 12 hours, then GET shows hints", async () => {
  const { deps } = setup();
  deps.runtime.store.setKey("OPENAI_API_KEY", "sk-proj-stored-abcdefghij1234");
  const res = await signIn(deps);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { owner: { address: string; expiresAt: number } };
  assert.equal(body.owner.address, owner.address);
  assert.equal(body.owner.expiresAt, deps.now!() + SESSION_TTL_MS);
  const setCookie = res.headers.get("set-cookie")!;
  assert.match(setCookie, new RegExp(`^${OWNER_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=43200/);
  assert.match(setCookie, /Path=\/api\/relay\/credentials/);
  assert.doesNotMatch(setCookie, /Secure/, "not on plain http");

  const anon = (await getCredentials(req("/api/relay/credentials"), deps).json()) as CredentialsResponse;
  assert.equal(anon.owner, null);
  assert.equal(anon.secretConfigured, true);
  assert.equal(anon.root, "acme.eth");
  assert.equal(anon.keys.find((k) => k.env === "OPENAI_API_KEY")!.hint, null);

  const mine = (await getCredentials(req("/api/relay/credentials", { cookie: cookieOf(res) }), deps).json()) as CredentialsResponse;
  assert.equal(mine.owner!.address, owner.address);
  assert.equal(mine.keys.find((k) => k.env === "OPENAI_API_KEY")!.hint, "sk-p••••••••1234");
});

test("the cookie is Secure behind https", async () => {
  const { deps } = setup();
  const { message } = await nonceFor(deps, owner.address);
  const signature = await owner.signMessage({ message });
  const res = await postSession(
    new Request(`${ORIGIN}/api/relay/credentials/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-proto": "https" },
      body: JSON.stringify({ address: owner.address, message, signature }),
    }),
    deps,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie")!, /; Secure/);
});

test("nonces are single-use and expire after 5 minutes", async () => {
  const { deps, clock } = setup();
  const { message } = await nonceFor(deps, owner.address);
  const signature = await owner.signMessage({ message });
  const send = () =>
    postSession(req("/api/relay/credentials/session", { method: "POST", body: JSON.stringify({ address: owner.address, message, signature }) }), deps);
  assert.equal((await send()).status, 200);
  const replay = await send();
  assert.equal(replay.status, 401);
  assert.match(((await replay.json()) as { reason: string }).reason, /expired or was already used/);

  const late = await nonceFor(deps, owner.address);
  const lateSig = await owner.signMessage({ message: late.message });
  clock.now += NONCE_TTL_MS + 1;
  const res = await postSession(
    req("/api/relay/credentials/session", { method: "POST", body: JSON.stringify({ address: owner.address, message: late.message, signature: lateSig }) }),
    deps,
  );
  assert.equal(res.status, 401);

  const store = new NonceStore(2);
  const a = store.issue(owner.address, () => "a");
  store.issue(owner.address, () => "b");
  store.issue(owner.address, () => "c");
  assert.equal(store.size, 2);
  assert.equal(store.consume(a.nonce), null, "oldest dropped past the cap");
});

test("wrong signer, a changed message, a non-owner and a RELAY_ROOT_OWNER mismatch are refused", async () => {
  {
    const { deps } = setup();
    const { message } = await nonceFor(deps, owner.address);
    const signature = await stranger.signMessage({ message });
    const res = await postSession(req("/api/relay/credentials/session", { method: "POST", body: JSON.stringify({ address: owner.address, message, signature }) }), deps);
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { reason: string }).reason, /signature/);
  }
  {
    const { deps } = setup();
    const res = await signIn(deps, owner, (m) => m.replace("acme.eth", "evil.eth"));
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { reason: string }).reason, /changed/);
  }
  {
    const { deps } = setup();
    const res = await signIn(deps, stranger);
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { reason: string }).reason, /doesn't own acme\.eth/);
    assert.equal(res.headers.get("set-cookie"), null);
  }
  {
    const { deps } = setup({ env: { RELAY_ROOT_OWNER: stranger.address } });
    const res = await signIn(deps, owner);
    assert.equal(res.status, 401);
    assert.match(((await res.json()) as { reason: string }).reason, /RELAY_ROOT_OWNER/);
  }
  {
    const { deps } = setup({ env: { RELAY_ROOT_OWNER: owner.address } });
    assert.equal((await signIn(deps, owner)).status, 200, "pinned and on-chain owner agree");
  }
});

test("failed sign-ins spend the failure budget (429 when empty)", async () => {
  const { deps } = setup();
  for (let i = 0; i < 40; i++) deps.limits.failures.spend("direct");
  const res = await signIn(deps, stranger);
  assert.equal(res.status, 429);
});

test("503 without RELAY_SECRET (or a short one) or without a root", async () => {
  for (const env of [{ RELAY_SECRET: "" }, { RELAY_SECRET: "short" }, { RELAY_ROOT_NAME: "" }]) {
    const { deps } = setup({ env });
    assert.equal(getNonce(req(`/api/relay/credentials/nonce?address=${owner.address}`), deps).status, 503);
    const put = await writeKey(req("/api/relay/credentials/keys/OPENAI_API_KEY", { method: "PUT", body: JSON.stringify({ value: "sk-x-0000000000000" }) }), "OPENAI_API_KEY", deps, false);
    assert.equal(put.status, env.RELAY_ROOT_NAME === "" ? 401 : 503);
  }
  const { deps } = setup({ env: { RELAY_SECRET: "" } });
  const body = (await getCredentials(req("/api/relay/credentials"), deps).json()) as CredentialsResponse;
  assert.equal(body.secretConfigured, false);
});

test("session cookies: expiry, other secret, other root and tampering", () => {
  const now = 1_800_000_000_000;
  const token = sessionToken(SECRET, "acme.eth", owner.address, now + 1000);
  assert.deepEqual(readSession(SECRET, "acme.eth", token, now), { address: owner.address, expiresAt: now + 1000 });
  assert.equal(readSession(SECRET, "acme.eth", token, now + 1000), null, "expired");
  assert.equal(readSession("d".repeat(64), "acme.eth", token, now), null, "other secret");
  assert.equal(readSession(SECRET, "other.eth", token, now), null, "other root");
  const [addr, exp, tag] = token.split(".");
  assert.equal(readSession(SECRET, "acme.eth", `${addr}.${Number(exp) + 1e9}.${tag}`, now), null, "extended expiry");
  assert.equal(readSession(SECRET, "acme.eth", `${stranger.address}.${exp}.${tag}`, now), null, "other address");
  assert.equal(readSession(SECRET, "acme.eth", "garbage", now), null);
});

test("an expired session can't write", async () => {
  const { deps, clock } = setup();
  const cookie = cookieOf(await signIn(deps));
  clock.now += SESSION_TTL_MS + 1;
  const res = await writeKey(req("/api/relay/credentials/keys/OPENAI_API_KEY", { method: "PUT", cookie, body: JSON.stringify({ value: "sk-proj-0000000000000000000" }) }), "OPENAI_API_KEY", deps, false);
  assert.equal(res.status, 401);
});

test("CSRF: cookie-authenticated writes need JSON and a same-origin Origin", async () => {
  const { deps } = setup();
  const cookie = cookieOf(await signIn(deps));
  const put = (init: Parameters<typeof req>[1]) =>
    writeKey(req("/api/relay/credentials/keys/OPENAI_API_KEY", { method: "PUT", cookie, body: JSON.stringify({ value: "sk-proj-0000000000000000000" }), ...init }), "OPENAI_API_KEY", deps, false);
  assert.equal((await put({ origin: "https://evil.example" })).status, 403);
  assert.equal((await put({ origin: null })).status, 403);
  assert.equal((await put({ json: false, headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await put({ headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await put({ origin: "http://localhost:3000" })).status, 200, "local alias of RELAY_PUBLIC_URL");
  assert.equal(deps.runtime.store.data.keys.OPENAI_API_KEY.value, "sk-proj-0000000000000000000");

  assert.equal(csrfProblem(new Request("https://relay.acme.test/x", { method: "POST", headers: { "content-type": "application/json; charset=utf-8", origin: "https://relay.acme.test" } }), ORIGIN), null);
  // Next hands route handlers http://localhost:<port> even when the page is on 127.0.0.1:<port>.
  const local = (origin: string, host?: string) =>
    csrfProblem(new Request("http://localhost:3100/x", { method: "POST", headers: { "content-type": "application/json", origin, ...(host ? { host } : {}) } }), ORIGIN);
  assert.equal(local("http://127.0.0.1:3100", "127.0.0.1:3100"), null, "local alias of the request's own origin");
  assert.equal(local("https://evil.example", "127.0.0.1:3100")?.status, 403);
  assert.equal(local("http://127.0.0.1:3101", "127.0.0.1:3100")?.status, 403, "another local port is another origin");
  assert.equal(local("http://evil.example", "evil.example")?.status, 403, "a Host header alone doesn't make an origin this relay");
  // The sign-in itself is also checked.
  const { message } = await nonceFor(deps, owner.address);
  const signature = await owner.signMessage({ message });
  const cross = await postSession(
    req("/api/relay/credentials/session", { method: "POST", origin: "https://evil.example", body: JSON.stringify({ address: owner.address, message, signature }) }),
    deps,
  );
  assert.equal(cross.status, 403);
});

test("writes: owner stores, clears, and the running environment follows; responses never carry the secret", async () => {
  const { deps, env } = setup({ env: { OPENAI_API_KEY: "sk-env-original-000000000" } });
  const anon = await writeKey(req("/api/relay/credentials/keys/OPENAI_API_KEY", { method: "PUT", body: JSON.stringify({ value: "sk-proj-x" }) }), "OPENAI_API_KEY", deps, false);
  assert.equal(anon.status, 401);

  const cookie = cookieOf(await signIn(deps));
  const secret = "sk-proj-newsecret-abcdefghij9876";
  const res = await writeKey(req("/api/relay/credentials/keys/OPENAI_API_KEY", { method: "PUT", cookie, body: JSON.stringify({ value: secret }) }), "OPENAI_API_KEY", deps, false);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text.includes(secret), false);
  const view = JSON.parse(text);
  assert.deepEqual([view.set, view.source, view.hint], [true, "store", "sk-p••••••••9876"]);
  assert.equal(env.OPENAI_API_KEY, secret, "applied to the running environment");
  assert.equal(loadConfig(env).isConfigured("openai-images"), true);

  const cleared = await writeKey(req("/api/relay/credentials/keys/OPENAI_API_KEY", { method: "DELETE", cookie }), "OPENAI_API_KEY", deps, true);
  assert.equal(cleared.status, 200);
  assert.equal(((await cleared.json()) as { source: string }).source, "env");
  assert.equal(env.OPENAI_API_KEY, "sk-env-original-000000000", "original restored");

  assert.equal((await writeKey(req("/api/relay/credentials/keys/RELAY_ROOT_OWNER", { method: "PUT", cookie, body: "{}" }), "RELAY_ROOT_OWNER", deps, false)).status, 404);
  assert.equal((await writeKey(req("/api/relay/credentials/keys/GITHUB_TOKEN", { method: "PUT", cookie, body: JSON.stringify({ nope: 1 }) }), "GITHUB_TOKEN", deps, false)).status, 400);
  assert.equal((await writeKey(req("/api/relay/credentials/keys/GITHUB_TOKEN", { method: "PUT", cookie, body: "not json" }), "GITHUB_TOKEN", deps, false)).status, 400);
});

test("custom services: create, update, delete; write-only", async () => {
  const { deps } = setup();
  const cookie = cookieOf(await signIn(deps));
  const created = await createCustom(req("/api/relay/credentials/custom", { method: "PUT", cookie, body: JSON.stringify({ label: "Acme CRM", value: "crm-live-abcdefghijklmnop", note: "https://crm.acme.test" }) }), deps);
  assert.equal(created.status, 201);
  const view = (await created.json()) as { id: string; hint: string; set: boolean; note: string };
  assert.match(view.id, /^acme-crm-[0-9a-f]{6}$/);
  assert.deepEqual([view.set, view.hint, view.note], [true, "crm-••••••••mnop", "https://crm.acme.test"]);

  const updated = await writeCustom(req(`/api/relay/credentials/custom/${view.id}`, { method: "PUT", cookie, body: JSON.stringify({ value: null }) }), view.id, deps, false);
  assert.equal(((await updated.json()) as { set: boolean }).set, false);
  const gone = await writeCustom(req(`/api/relay/credentials/custom/${view.id}`, { method: "DELETE", cookie }), view.id, deps, true);
  assert.equal(((await gone.json()) as { deleted: boolean }).deleted, true);
  assert.equal((await writeCustom(req(`/api/relay/credentials/custom/${view.id}`, { method: "DELETE", cookie }), view.id, deps, true)).status, 404);
});

test("custom ids are own entries only: 'constructor' is not a service", async () => {
  const { deps, store } = setup();
  const cookie = cookieOf(await signIn(deps));
  const put = await writeCustom(req("/api/relay/credentials/custom/constructor", { method: "PUT", cookie, body: JSON.stringify({ value: "sk-abcdefghijklmnop" }) }), "constructor", deps, false);
  assert.equal(put.status, 404);
  const del = await writeCustom(req("/api/relay/credentials/custom/constructor", { method: "DELETE", cookie }), "constructor", deps, true);
  assert.equal(del.status, 404);
  assert.deepEqual(Object.keys(store.data.custom), []);
});

test("bodies over 16 KB are refused before they are read in full", async () => {
  const { deps } = setup();
  const big = await postSession(
    req("/api/relay/credentials/session", { method: "POST", headers: { "content-length": String(1024 * 1024) }, body: "{}" }),
    deps,
  );
  assert.equal(big.status, 413);

  // A chunked body with no length: cut off once it passes the limit.
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (pulled > 1000) return controller.close();
      controller.enqueue(new Uint8Array(4096).fill(0x20));
    },
  });
  const chunked = await postSession(
    new Request(`${ORIGIN}/api/relay/credentials/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: stream,
      duplex: "half",
    } as RequestInit),
    deps,
  );
  assert.equal(chunked.status, 413);
  assert.ok(pulled < 20, `stopped reading early (${pulled} chunks)`);
});

test("anonymous callers don't see where the credentials file lives or why it failed", async () => {
  const { deps, env } = setup({ env: { RELAY_ADMIN_TOKEN: "admin-token-0123456789abcdef" } });
  const broken = new CredentialStore(path.join(env.RELAY_DATA_DIR!, "missing-dir", "..", "credentials.json"), env.RELAY_SECRET);
  Object.defineProperty(broken, "error", { value: `${path.join(env.RELAY_DATA_DIR!, "credentials.json")} can't be read (EACCES: permission denied)` });
  deps.runtime = { ...deps.runtime, store: broken };
  const anon = (await getCredentials(req("/api/relay/credentials"), deps).json()) as CredentialsResponse;
  assert.ok(anon.storeError);
  assert.equal(anon.storeError!.includes(env.RELAY_DATA_DIR!), false);
  assert.equal(/EACCES/.test(anon.storeError!), false);
  const admin = (await getCredentials(new Request(`${ORIGIN}/api/relay/credentials`, { headers: { authorization: "Bearer admin-token-0123456789abcdef" } }), deps).json()) as CredentialsResponse;
  assert.match(admin.storeError!, /EACCES/);
});

test("the owner loses write access when the root changes hands; the admin token works without a cookie", async () => {
  const { deps, chain } = setup({ env: { RELAY_ADMIN_TOKEN: "admin-token-0123456789abcdef" } });
  const cookie = cookieOf(await signIn(deps));
  chain.levels[0] = level("acme.eth", stranger.address, null);
  const res = await writeKey(req("/api/relay/credentials/keys/GITHUB_TOKEN", { method: "PUT", cookie, body: JSON.stringify({ value: "github_pat_0000000000000000" }) }), "GITHUB_TOKEN", deps, false);
  assert.equal(res.status, 403);
  assert.match(res.headers.get("set-cookie")!, /Max-Age=0/);

  const admin = await writeKey(
    new Request(`${ORIGIN}/api/relay/credentials/keys/GITHUB_TOKEN`, { method: "PUT", headers: { authorization: "Bearer admin-token-0123456789abcdef" }, body: JSON.stringify({ value: "github_pat_0000000000000000" }) }),
    "GITHUB_TOKEN",
    deps,
    false,
  );
  assert.equal(admin.status, 200, "bearer admin: no cookie, so no CSRF check");
  const view = (await getCredentials(new Request(`${ORIGIN}/api/relay/credentials`, { headers: { authorization: "Bearer admin-token-0123456789abcdef" } }), deps).json()) as CredentialsResponse;
  assert.equal(view.admin, true);
  assert.equal(view.keys.find((k) => k.env === "GITHUB_TOKEN")!.hint, "gith••••••••0000");
});

test("sign out clears the cookie", async () => {
  const { deps } = setup();
  const res = await postSession(req("/api/relay/credentials/session", { method: "POST", body: JSON.stringify({ action: "signout" }) }), deps);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie")!, /^relay_owner=; .*Max-Age=0/);
});
