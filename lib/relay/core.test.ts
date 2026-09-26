import assert from "node:assert/strict";
import { test } from "node:test";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { RECORD_KEYS, bundleToRecords, evaluate, parseBundle, periodKey } from "./bundle";
import { TokenError, createToken, tokenFromHeaders, verifyToken } from "./token";

const bundle = (keys: string, caps: Record<string, string> = {}, period = "month") =>
  parseBundle({
    [RECORD_KEYS.keys]: keys,
    [RECORD_KEYS.period]: period,
    ...Object.fromEntries(Object.entries(caps).map(([p, v]) => [RECORD_KEYS.cap(p), v])),
  });

test("parseBundle: no keys record means no access", () => {
  assert.equal(parseBundle({}), null);
  assert.equal(parseBundle({ [RECORD_KEYS.keys]: "  " }), null);
});

test("parseBundle: drops unknown providers, bad caps become 0, default period month", () => {
  const b = parseBundle({ [RECORD_KEYS.keys]: "Claude, github nope", [RECORD_KEYS.cap("claude")]: "abc" })!;
  assert.deepEqual(b.keys, ["claude", "github"]);
  assert.equal(b.caps.claude, 0);
  assert.equal(b.period, "month");
});

test("bundleToRecords round-trips and clears unset caps", () => {
  const b = bundle("claude,codex", { claude: "100" })!;
  const records = Object.fromEntries(bundleToRecords(b));
  assert.equal(records[RECORD_KEYS.cap("codex")], "");
  assert.deepEqual(parseBundle(records), b);
});

test("evaluate: every level must allow the provider", () => {
  const levels = [
    { name: "acme.eth", bundle: bundle("claude,codex,github"), spent: {} },
    { name: "eng.acme.eth", bundle: bundle("claude,github"), spent: {} },
    { name: "derek.eng.acme.eth", bundle: bundle("claude,codex"), spent: {} },
  ];
  assert.equal(evaluate(levels, "claude").allowed, true);
  const codex = evaluate(levels, "codex");
  assert.equal(codex.allowed, false);
  assert.match(codex.reason!, /eng\.acme\.eth does not allow codex/);
});

test("evaluate: a child cap can't exceed an exhausted parent cap", () => {
  const levels = [
    { name: "eng.acme.eth", bundle: bundle("claude", { claude: "50" }), spent: { claude: 50 } },
    { name: "derek.eng.acme.eth", bundle: bundle("claude", { claude: "1000" }), spent: {} },
  ];
  const d = evaluate(levels, "claude");
  assert.equal(d.allowed, false);
  assert.match(d.reason!, /eng\.acme\.eth has used its claude cap/);
});

test("evaluate: remaining is the tightest cap", () => {
  const levels = [
    { name: "eng.acme.eth", bundle: bundle("claude", { claude: "5000" }), spent: { claude: 10 } },
    { name: "derek.eng.acme.eth", bundle: bundle("claude", { claude: "100" }), spent: { claude: 40 } },
    { name: "laptop.derek.eng.acme.eth", bundle: bundle("claude"), spent: {} },
  ];
  assert.deepEqual(evaluate(levels, "claude"), { allowed: true, reason: null, remaining: 60, remainingCount: null });
});

test("evaluate: count limits (e.g. 1 image) are enforced at every level", () => {
  const withMax = (keys: string, max: Record<string, string>) =>
    parseBundle({
      [RECORD_KEYS.keys]: keys,
      ...Object.fromEntries(Object.entries(max).map(([p, v]) => [RECORD_KEYS.max(p), v])),
    });
  const levels = [
    { name: "codex.derek.dev.eng.acme.eth", bundle: withMax("openai-images", { "openai-images": "2" }), spent: {}, used: { "openai-images": 1 } },
    { name: "image.codex.derek.dev.eng.acme.eth", bundle: withMax("openai-images", { "openai-images": "1" }), spent: {}, used: {} },
  ];
  assert.deepEqual(evaluate(levels, "openai-images"), { allowed: true, reason: null, remaining: null, remainingCount: 1 });
  levels[1].used = { "openai-images": 1 };
  const d = evaluate(levels, "openai-images");
  assert.equal(d.allowed, false);
  assert.match(d.reason!, /image\.codex.* has used its openai-images limit \(1 image\)/);
});

test("parseBundle: count limits are whole numbers and bad values deny", () => {
  const b = parseBundle({ [RECORD_KEYS.keys]: "stripe", [RECORD_KEYS.max("stripe")]: "2.7", [RECORD_KEYS.max("github")]: "nope" })!;
  assert.equal(b.maxes!.stripe, 2);
  assert.equal(b.maxes!.github, 0);
});

test("evaluate: missing bundle anywhere denies", () => {
  const d = evaluate([{ name: "acme.eth", bundle: null, spent: {} }], "claude");
  assert.equal(d.allowed, false);
});

test("periodKey", () => {
  const now = new Date("2026-09-26T23:59:00Z");
  assert.equal(periodKey("month", now), "2026-09");
  assert.equal(periodKey("day", now), "2026-09-26");
  assert.equal(periodKey("total", now), "total");
});

test("token: sign, verify, recover signer", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const token = await createToken(account, { name: "laptop.derek.eng.acme.eth", iat: now, exp: now + 3600 });
  const { payload, signer } = await verifyToken(token, now);
  assert.equal(signer, account.address);
  assert.equal(payload.name, "laptop.derek.eng.acme.eth");
});

test("token: expired and tampered tokens are rejected", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const now = Math.floor(Date.now() / 1000);
  const token = await createToken(account, { name: "a.acme.eth", iat: now, exp: now + 60 });
  await assert.rejects(verifyToken(token, now + 61), TokenError);

  // Swapping the payload for another name must not keep the original signer.
  const [, , sig] = token.split(".");
  const forged = await createToken(account, { name: "b.acme.eth", iat: now, exp: now + 60 });
  const tampered = `${forged.split(".").slice(0, 2).join(".")}.${sig}`;
  const { signer } = await verifyToken(tampered, now);
  assert.notEqual(signer, account.address);
});

test("tokenFromHeaders reads x-api-key and bearer, ignores real provider keys", () => {
  assert.equal(tokenFromHeaders(new Headers({ "x-api-key": "kr1.a.0x00" })), "kr1.a.0x00");
  assert.equal(tokenFromHeaders(new Headers({ authorization: "Bearer kr1.a.0x00" })), "kr1.a.0x00");
  assert.equal(tokenFromHeaders(new Headers({ "x-api-key": "sk-ant-real" })), null);
});
