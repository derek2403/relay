import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  type AttestationResponse,
  PHALA_VERIFY_URL,
  canonicalJson,
  checkBinding,
  parseNonce,
  parseTdxQuote,
  reportDataFor,
  statementHash,
  toHex,
} from "./attestation-core";
import { type AttestationDeps, type Quoter, attest, buildStatement, handleAttestation, resetAttestationCache } from "./attestation";
import { CATALOG } from "./catalog";
import { loadConfig } from "./config";
import { ClientLimit } from "./ratelimit";

/** A TDX quote: 48-byte header, a TD report body with recognizable fields, and a fake signature section. */
function fixtureQuote(reportData: Uint8Array, opts: { version?: 4 | 5; tee?: number } = {}): string {
  const version = opts.version ?? 4;
  const header = new Uint8Array(48);
  header[0] = version;
  header[2] = 2; // ECDSA-256
  new DataView(header.buffer).setUint32(4, opts.tee ?? 0x81, true);
  const body = new Uint8Array(584);
  const fill = (offset: number, len: number, byte: number) => body.fill(byte, offset, offset + len);
  fill(16, 48, 0x11); // MRSEAM
  fill(136, 48, 0xaa); // MRTD
  fill(328, 48, 0x01); // RTMR0
  fill(376, 48, 0x02);
  fill(424, 48, 0x03);
  fill(472, 48, 0x04);
  body.set(reportData, 520);
  const descriptor = version === 5 ? Uint8Array.from([2, 0, 0x48, 0x02, 0, 0]) : new Uint8Array(0);
  const sig = new Uint8Array(64).fill(0xee);
  return toHex(Uint8Array.from([...header, ...descriptor, ...body, ...sig]));
}

/** Answers like Phala's simulator: a quote carrying the report data it was given. */
const simulator = (calls = { n: 0 }): Quoter => ({
  async getQuote(reportData) {
    calls.n++;
    return { quote: fixtureQuote(reportData), event_log: JSON.stringify([{ imr: 0, event: "boot" }]) };
  },
  async info() {
    return { app_id: "app-1", instance_id: "inst-1", app_cert: "-----BEGIN CERTIFICATE-----", tcb_info: { mrtd: "aa" } };
  },
});

const ENV = { RELAY_ROOT_NAME: "acme.eth", RELAY_ROOT_OWNER: "0x000000000000000000000000000000000000dEaD", RELAY_PUBLIC_URL: "http://127.0.0.1:3000", OPENAI_API_KEY: "sk-proj-secret-value-000000", RELAY_BUILD_ID: "v1.2.3" };

function deps(extra: Partial<AttestationDeps> = {}, env: Record<string, string> = { ...ENV, DSTACK_SIMULATOR_ENDPOINT: "http://localhost:8090" }): AttestationDeps {
  return { config: loadConfig(env), env, quoter: async () => simulator(), now: () => Date.parse("2026-09-26T12:00:00Z"), ...extra };
}

test("canonical JSON: sorted keys, no whitespace, undefined dropped, only finite numbers", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: undefined, x: "é" } }), '{"a":[true,null,"x"],"b":1,"c":{"x":"é","z":1}}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: NaN }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
});

test("the statement lists catalog services and has no secrets; its hash is sha256 of the canonical JSON", () => {
  const d = deps();
  const s = buildStatement(d.config, d.env, null, d.now!());
  assert.equal(s.relay, "http://127.0.0.1:3000/api/relay");
  assert.equal(s.root, "acme.eth");
  assert.equal(s.rootOwner, "0x000000000000000000000000000000000000dEaD");
  assert.equal(s.build, "v1.2.3");
  assert.equal(s.issuedAt, "2026-09-26T12:00:00.000Z");
  assert.deepEqual(s.services.map((x) => x.id), CATALOG.map((p) => p.id));
  assert.equal(s.services.find((x) => x.id === "codex")!.configured, true);
  assert.equal(s.services.find((x) => x.id === "openai-images")!.configured, true);
  assert.equal(s.services.find((x) => x.id === "claude")!.configured, false);
  assert.equal(JSON.stringify(s).includes("sk-proj"), false);
  assert.equal(statementHash(s), createHash("sha256").update(canonicalJson(s)).digest("hex"));
});

test("report data is the statement hash followed by the nonce (zero-padded)", () => {
  const hash = "ab".repeat(32);
  assert.equal(reportDataFor(hash, null), hash + "0".repeat(64));
  assert.equal(reportDataFor(hash, "c0ffee"), hash + "c0ffee" + "0".repeat(58));
  assert.equal(reportDataFor(`0x${hash}`, null).length, 128);
  assert.equal(parseNonce("0xC0FFEE"), "c0ffee");
  assert.equal(parseNonce(""), null);
  assert.equal(parseNonce(null), null);
  assert.throws(() => parseNonce("abc"), /hex/);
  assert.throws(() => parseNonce("zz"), /hex/);
  assert.throws(() => parseNonce("00".repeat(33)), /hex/);
});

test("TDX quotes v4 and v5 are parsed; other quotes are not", () => {
  const rd = new Uint8Array(64).fill(0x5a);
  for (const version of [4, 5] as const) {
    const m = parseTdxQuote(fixtureQuote(rd, { version }))!;
    assert.equal(m.version, version);
    assert.equal(m.teeType, "TDX");
    assert.equal(m.mrSeam, "11".repeat(48));
    assert.equal(m.mrtd, "aa".repeat(48));
    assert.equal(m.rtmr0, "01".repeat(48));
    assert.equal(m.rtmr3, "04".repeat(48));
    assert.equal(m.reportData, "5a".repeat(64));
  }
  assert.equal(parseTdxQuote(`0x${fixtureQuote(rd)}`)!.reportData, "5a".repeat(64), "0x prefix accepted");
  assert.equal(parseTdxQuote(fixtureQuote(rd, { tee: 0 })), null, "SGX");
  assert.equal(parseTdxQuote("0400"), null, "too short");
  assert.equal(parseTdxQuote("not hex"), null);
});

test("attest: the quote carries sha256(statement) ‖ nonce and the binding checks out", async () => {
  const res = await attest(deps(), "c0ffee");
  assert.equal(res.source, "simulator");
  assert.equal(res.verifyUrl, PHALA_VERIFY_URL);
  assert.equal(res.statement.nonce, "c0ffee");
  assert.equal(res.statementHash, statementHash(res.statement));
  assert.equal(res.reportData, reportDataFor(res.statementHash, "c0ffee"));
  assert.equal(res.measurements!.reportData, res.reportData);
  assert.deepEqual(res.eventLog, [{ imr: 0, event: "boot" }]);
  assert.deepEqual(res.info, { appId: "app-1", instanceId: "inst-1" }, "no certificates or tcb dumps");
  assert.deepEqual(checkBinding(res.statement, res.quote), { statementHash: res.statementHash, quoteReportData: res.reportData, bound: true, nonceBound: true });

  const changed = { ...res.statement, root: "evil.eth" };
  assert.equal(checkBinding(changed, res.quote).bound, false);

  const tee = await attest(deps({}, ENV), null);
  assert.equal(tee.source, "tee", "no simulator endpoint: a CVM socket");
});

test("503 no-tee when dstack is missing, fails or hangs", async () => {
  resetAttestationCache();
  const url = "http://127.0.0.1:3000/api/relay/attestation";
  const missing = await handleAttestation(new Request(url), deps({ quoter: async () => { throw new Error("Unix socket file /var/run/dstack.sock does not exist"); } }));
  assert.equal(missing.status, 503);
  const body = (await missing.json()) as { error: string; reason: string; hint: string; detail: string };
  assert.equal(body.reason, "no-tee");
  assert.match(body.hint, /DSTACK_SIMULATOR_ENDPOINT/);
  assert.match(body.detail, /dstack\.sock/);

  const refused = await handleAttestation(new Request(`${url}?nonce=01`), deps({ quoter: async () => ({ getQuote: () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:8090")) }) }));
  assert.equal(refused.status, 503);

  const hang = await handleAttestation(new Request(`${url}?nonce=02`), deps({ timeoutMs: 20, quoter: async () => ({ getQuote: () => new Promise(() => {}) }) }));
  assert.equal(hang.status, 503);
  assert.match(((await hang.json()) as { detail: string }).detail, /did not answer/);
});

test("nonce-less calls are cached for 30 s; nonce calls are fresh and rate limited; bad nonces are 400", async () => {
  resetAttestationCache();
  const calls = { n: 0 };
  let now = Date.parse("2026-09-26T12:00:00Z");
  const d = deps({ quoter: async () => simulator(calls), now: () => now });
  const url = "http://127.0.0.1:3000/api/relay/attestation";
  const first = (await (await handleAttestation(new Request(url), d)).json()) as AttestationResponse;
  now += 10_000;
  const second = (await (await handleAttestation(new Request(url), d)).json()) as AttestationResponse;
  assert.equal(calls.n, 1);
  assert.equal(second.quote, first.quote);
  now += 30_000;
  await handleAttestation(new Request(url), d);
  assert.equal(calls.n, 2, "expired");

  const limit = new ClientLimit([2, 0], [100, 0]);
  const a = await handleAttestation(new Request(`${url}?nonce=aa`), d, limit);
  const b = await handleAttestation(new Request(`${url}?nonce=bb`), d, limit);
  assert.equal(((await a.json()) as AttestationResponse).statement.nonce, "aa");
  assert.equal(((await b.json()) as AttestationResponse).statement.nonce, "bb");
  assert.equal(calls.n, 4);
  assert.equal((await handleAttestation(new Request(`${url}?nonce=cc`), d, limit)).status, 429);

  assert.equal((await handleAttestation(new Request(`${url}?nonce=xyz`), d)).status, 400);
});
