// World ID pieces: config parsing, the rp_context message and signature
// (vectors from @worldcoin/idkit-core 4.3.0), hashSignal vectors (from
// @worldcoin/idkit 4.3.0 /hashing), local result checks, the Portal verify
// call against a local fake, and the preflight probe classification.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { bytesToHex, recoverMessageAddress } from "viem";
import { privateKeyToAddress } from "viem/accounts";

import { fakeUpstream } from "../testkit";
import { worldConfig, worldStatus } from "./config";
import { classifyProbe, runPreflight } from "./preflight";
import { hashSignal, rpMessage, rpSignerAddress, signRpContext } from "./rp";
import { checkWorldResult, normalizeNullifier, verifyWithPortal, verifyWorldProof } from "./verify";

const KEY = `0x${"11".repeat(32)}` as const;
const ENV = {
  WORLD_APP_ID: "app_test123",
  WORLD_RP_ID: "rp_test123",
  WORLD_RP_SIGNING_KEY: KEY,
  WORLD_ACTION: "relay-approver",
  WORLD_ENVIRONMENT: "production",
};

let reply: { status: number; body: string } = { status: 200, body: "{}" };
let portal: Awaited<ReturnType<typeof fakeUpstream>>;
before(async () => {
  portal = await fakeUpstream((_req, res) => {
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
});
after(() => portal.close());

const cfg = () => worldConfig({ ...ENV, WORLD_PORTAL_URL: portal.url }).config!;

test("config: every required variable, prefixes, key format and environment are checked", () => {
  const empty = worldConfig({});
  assert.equal(empty.config, null);
  assert.deepEqual(empty.problems.map((p) => p.name), ["WORLD_APP_ID", "WORLD_RP_ID", "WORLD_RP_SIGNING_KEY", "WORLD_ACTION", "WORLD_ENVIRONMENT"]);
  const bad = worldConfig({ ...ENV, WORLD_APP_ID: "rp_x", WORLD_RP_SIGNING_KEY: "0x12", WORLD_ENVIRONMENT: "sandbox" });
  assert.deepEqual(bad.problems.map((p) => p.name), ["WORLD_APP_ID", "WORLD_RP_SIGNING_KEY", "WORLD_ENVIRONMENT"]);
  const good = worldConfig({ ...ENV, WORLD_PORTAL_URL: "https://x.test///" });
  assert.equal(good.config?.portalUrl, "https://x.test");
  assert.equal(worldConfig(ENV).config?.portalUrl, "https://developer.world.org");
  const status = worldStatus({ ...ENV, WORLD_RP_SIGNING_KEY: "0xnot-a-key" });
  assert.equal(status.configured, false);
  assert.ok(status.problems[0].startsWith("WORLD_RP_SIGNING_KEY"));
  assert.ok(!JSON.stringify(worldStatus(ENV)).includes("1111"), "the key never appears in status");
});

test("rp message: byte layout and signature match the IDKit SDK vectors", async () => {
  const nonce = `0x00${"ab".repeat(31)}` as const;
  const msg = rpMessage({ nonce, createdAt: 1790000000, expiresAt: 1790000300, action: "relay-incident-approval" });
  assert.equal(msg.length, 81);
  assert.equal(
    bytesToHex(msg),
    "0x0100ababababababababababababababababababababababababababababababab000000006ab13b80000000006ab13cac00ae1e5baced308ea2ec935fc07bc03628b2970f52d993c48c3f8d4baa0da54f",
  );
  assert.equal(rpMessage({ nonce, createdAt: 1790000000, expiresAt: 1790000300 }).length, 49);
  const { privateKeyToAccount } = await import("viem/accounts");
  const sig = await privateKeyToAccount(KEY).signMessage({ message: { raw: msg } });
  assert.equal(
    sig,
    "0xed3fc4b87580c165c9d78ee1b4c4b89d8f76840d06247feb4cb8d98a4c55a9bf74e0e59964eb8f6e9dca7960e5ba771a42ec377bb35f113981074df4dad1fca71c",
  );
});

test("signRpContext: fresh nonce, 300 s ttl, signature recovers to the key's address", async () => {
  const ctx = await signRpContext({ rpId: "rp_x", signingKey: KEY, action: "relay-approver" }, { nowSec: 1_800_000_000 });
  assert.equal(ctx.rp_id, "rp_x");
  assert.equal(ctx.expires_at - ctx.created_at, 300);
  assert.match(ctx.nonce, /^0x00[0-9a-f]{62}$/);
  const raw = rpMessage({ nonce: ctx.nonce, createdAt: ctx.created_at, expiresAt: ctx.expires_at, action: "relay-approver" });
  assert.equal(await recoverMessageAddress({ message: { raw }, signature: ctx.signature }), privateKeyToAddress(KEY));
  assert.equal(rpSignerAddress(KEY), privateKeyToAddress(KEY));
  const again = await signRpContext({ rpId: "rp_x", signingKey: KEY, action: "relay-approver" });
  assert.notEqual(again.nonce, ctx.nonce);
});

test("hashSignal: vectors from @worldcoin/idkit/hashing (UTF-8 and 0x-bytes branches)", () => {
  const vectors: Record<string, string> = {
    "relay-approve:v1:0x1111111111111111111111111111111111111111111111111111111111111111": "0x006c53a52e3289c2c103385352111ab32dab53f1f5f4bada7a4f7d2f00526012",
    "relay-enroll:v1:0xabcdef0000000000000000000000000000000001:ch_test": "0x00dadcfd8d2f750e833a4e03947ac371164c92c4476812b897ebc2d5c841314c",
    "relay-approve:v1:0x1234": "0x00d7c906c1ad1f74a87fd20c0461f1823efd465e476d3c02f136e6d408439aa2",
    "0x1234": "0x0056570de287d73cd1cb6092bb8fdee6173974955fdef345ae579ee9f475ea74",
    "0xdead": "0x003905d344717efd562447a4960eea941c1244adc31f53525d0ec1397ff6951c",
    "0x": "0x0039bef1777deb3dfb14f64b9f81ced092c501fee72f90e93d03bb95ee89df98",
    "0xabc": "0x00851bb152e67e6c958ab7da1431fcaed09ce0efc598885f69a750b3b4b81fc1",
    "": "0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4",
  };
  for (const [s, h] of Object.entries(vectors)) assert.equal(hashSignal(s), h, s);
});

const N1 = `0x${"0a".repeat(32)}`;
const result = (over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => ({
  protocol_version: "3.0",
  nonce: "0x01",
  action: "relay-approver",
  environment: "sandbox",
  responses: [{ identifier: "selfie", signal_hash: hashSignal("sig-a"), proof: `0x${"22".repeat(64)}`, merkle_root: "0x05", nullifier: N1, ...item }],
  ...over,
});
const expect = { signal: "sig-a", nonce: "0x01", action: "relay-approver" };

test("checkWorldResult: protocol, one selfie response, signal, nonce, action", () => {
  assert.equal(checkWorldResult(result(), expect).ok, true);
  assert.equal(checkWorldResult(result({}, { identifier: "face" }), expect).ok, true);
  const code = (r: unknown) => {
    const c = checkWorldResult(r, expect);
    return c.ok ? "ok" : c.code;
  };
  assert.equal(code(null), "missing_result");
  assert.equal(code(result({ protocol_version: "4.0" })), "wrong_protocol_version");
  assert.equal(code(result({}, { identifier: "orb" })), "wrong_credential");
  assert.equal(code({ ...result(), responses: [...result().responses, ...result().responses] }), "wrong_credential");
  assert.equal(code(result({}, { signal_hash: hashSignal("sig-b") })), "signal_mismatch");
  assert.equal(code(result({}, { signal_hash: undefined })), "signal_mismatch");
  assert.equal(code(result({ nonce: "0x02" })), "nonce_mismatch");
  assert.equal(code(result({ action: "other" })), "action_mismatch");
  assert.equal(normalizeNullifier("10"), `0x${"0".repeat(63)}a`);
  assert.equal(normalizeNullifier("nope"), null);
});

const success = (n = N1, env = "production") => JSON.stringify({ success: true, action: "relay-approver", nullifier: n, environment: env, results: [{ identifier: "selfie", success: true, nullifier: n }] });

test("portal: success; environment and action pinned in the body; staging token only when set", async () => {
  reply = { status: 200, body: success() };
  const v = await verifyWorldProof(cfg(), result(), expect);
  assert.deepEqual(v, { ok: true, nullifier: N1, environment: "production", presence: null });
  const sent = JSON.parse(portal.last().body);
  assert.equal(sent.environment, "production", "the client's sandbox is overridden");
  assert.equal(sent.action, "relay-approver");
  assert.equal(sent.responses[0].proof, result().responses[0].proof, "forwarded unchanged");
  assert.equal(portal.last().url, "/api/v4/verify/rp_test123");
  assert.equal(portal.last().headers["x-staging-verification-token"], undefined);
  await verifyWithPortal({ ...cfg(), stagingToken: "tok" }, result());
  assert.equal(portal.last().headers["x-staging-verification-token"], "tok");
});

test("portal: partial success, all_verifications_failed, environment mismatch, non-JSON, unreachable", async () => {
  reply = { status: 200, body: JSON.stringify({ success: true, results: [{ identifier: "selfie", success: false, code: "invalid_merkle_root" }, { identifier: "orb", success: true }] }) };
  let v = await verifyWithPortal(cfg(), result());
  assert.equal(v.ok ? "ok" : v.code, "world_rejected:invalid_merkle_root");
  reply = { status: 400, body: JSON.stringify({ success: false, code: "all_verifications_failed", results: [{ identifier: "selfie", success: false, code: "invalid_proof" }] }) };
  v = await verifyWithPortal(cfg(), result());
  assert.equal(v.ok ? "ok" : v.code, "world_rejected:invalid_proof");
  reply = { status: 200, body: success(N1, "staging") };
  v = await verifyWithPortal(cfg(), result());
  assert.equal(v.ok ? "ok" : v.code, "environment_mismatch");
  reply = { status: 200, body: "<html>oops</html>" };
  v = await verifyWithPortal(cfg(), result());
  assert.equal(v.ok ? "ok" : `${v.status} ${v.code}`, "502 world_unreachable");
  v = await verifyWithPortal({ ...cfg(), portalUrl: "http://127.0.0.1:1" }, result());
  assert.equal(v.ok ? "ok" : `${v.status} ${v.code}`, "502 world_unreachable");
  reply = { status: 200, body: success(`0x${"0b".repeat(32)}`) };
  v = await verifyWithPortal(cfg(), result());
  assert.equal(v.ok ? "ok" : v.code, "world_rejected:nullifier_mismatch");
});

test("preflight: config problems block; the fake-proof probe classifies all_verifications_failed as ok", async () => {
  const off = await runPreflight({});
  assert.equal(off.configured, false);
  assert.ok(off.checks.every((c) => c.status === "blocked"));
  reply = { status: 400, body: JSON.stringify({ success: false, code: "all_verifications_failed" }) };
  const pf = await runPreflight({ ...ENV, WORLD_PORTAL_URL: portal.url, WORLD_RP_SIGNER_ADDRESS: privateKeyToAddress(KEY) });
  assert.equal(pf.configured, true);
  const by = Object.fromEntries(pf.checks.map((c) => [c.id, c.status]));
  assert.deepEqual(by, { env: "ok", environment: "ok", signing: "ok", signer: "ok", rp: "ok", selfie_flag: "unknown" });
  const probe = JSON.parse(portal.last().body);
  assert.equal(probe.responses[0].nullifier, `0x${"00".repeat(32)}`, "a deliberately fake proof");
  const mismatch = await runPreflight({ ...ENV, WORLD_PORTAL_URL: portal.url, WORLD_RP_SIGNER_ADDRESS: "0x0000000000000000000000000000000000000001" });
  assert.equal(mismatch.checks.find((c) => c.id === "signer")?.status, "blocked");
  assert.equal(classifyProbe(400, { code: "rp_not_active" }).status, "blocked");
  assert.equal(classifyProbe(200, { success: true }).status, "blocked");
  assert.equal(classifyProbe(418, null).status, "unknown");
});
