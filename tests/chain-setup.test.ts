// npm run chain:setup, offline: settings, derived recipients, the idempotent step plan,
// reseed plan, ETH math, progress file and the workspace it writes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { type Address, type Hex, getAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { SIMPLE_ESCROW } from "../lib/chain/artifacts";
import { parseChainWorkspace } from "../lib/chain/config";
import { tempDir } from "../lib/relay/testkit";
import {
  type Observed,
  SEED,
  SEED_TOTAL,
  SetupError,
  blockers,
  buildWorkspace,
  deriveRecipients,
  ethNeeded,
  maxFeeFor,
  parseArgs,
  planReseed,
  planSetup,
  readProgress,
  recipientKey,
  setupEnv,
  std,
  writeProgress,
  emptyProgress,
} from "../scripts/lib/chain-setup";

const FUNDER_KEY = `0x${"42".repeat(32)}` as Hex;
const SIGNER_KEY = `0x${"43".repeat(32)}` as Hex;
const funder = privateKeyToAccount(FUNDER_KEY).address;
const signer = privateKeyToAccount(SIGNER_KEY).address;
const root = getAddress("0x00000000000000000000000000000000000000a3");
const token = getAddress("0x00000000000000000000000000000000000000a1");
const vault = getAddress("0x00000000000000000000000000000000000000a2");

const fresh = (): Observed => ({
  funder,
  signer,
  rootOwner: root,
  uploads: { "relay-token": "missing", "relay-vault": "missing", "relay-escrow": "missing" },
  token: null,
  vault: null,
  signerBalance: 0n,
  seeded: {},
});

const finished = (): Observed => ({
  ...fresh(),
  uploads: { "relay-token": "same", "relay-vault": "same", "relay-escrow": "same" },
  token: { address: token, owner: funder, aliased: true, linked: true },
  vault: { address: vault, owner: root, agent: signer, token, aliased: true, linked: true, paused: false, balance: std("731"), approved: { supplier: true, contractor: true } },
  signerBalance: parseEther("0.03"),
  seeded: { supplier: `0x${"01".repeat(32)}`, contractor: `0x${"02".repeat(32)}`, outsider: `0x${"03".repeat(32)}` },
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs([]), { plan: false, reseed: false, help: false });
  assert.deepEqual(parseArgs(["--plan", "--reseed"]), { plan: true, reseed: true, help: false });
  assert.throws(() => parseArgs(["--yolo"]), SetupError);
});

test("setupEnv validates keys and roles", () => {
  const env = { MULTIBAAS_URL: "https://x.multibaas.com", MULTIBAAS_API_KEY: "k", FUNDER_PRIVATE_KEY: FUNDER_KEY.slice(2), RELAY_ROOT_OWNER: root.toLowerCase() };
  const s = setupEnv(env);
  assert.equal(s.funderKey, FUNDER_KEY);
  assert.equal(s.rootOwner, root);
  assert.equal(s.signerKey, null);
  assert.equal(s.dataDir, ".data");
  assert.equal(setupEnv({ ...env, MULTIBAAS_SIGNER_PRIVATE_KEY: SIGNER_KEY }).signerKey, SIGNER_KEY);
  assert.throws(() => setupEnv({ ...env, MULTIBAAS_API_KEY: "" }), /MULTIBAAS_API_KEY/);
  assert.throws(() => setupEnv({ ...env, FUNDER_PRIVATE_KEY: "0x12" }), /FUNDER_PRIVATE_KEY/);
  assert.throws(() => setupEnv({ ...env, RELAY_ROOT_OWNER: "derek.eth" }), /RELAY_ROOT_OWNER/);
  assert.throws(() => setupEnv({ ...env, MULTIBAAS_SIGNER_PRIVATE_KEY: FUNDER_KEY }), /dedicated/);
  assert.throws(() => setupEnv({ ...env, RELAY_ROOT_OWNER: signer, MULTIBAAS_SIGNER_PRIVATE_KEY: SIGNER_KEY }), /relay signer/);
});

test("recipients are deterministic, distinct and not the funder", () => {
  const a = deriveRecipients(FUNDER_KEY);
  assert.deepEqual(deriveRecipients(FUNDER_KEY), a);
  const all = [a.recipients.supplier, a.recipients.contractor, a.outsider, funder];
  assert.equal(new Set(all).size, 4);
  assert.equal(a.recipients.supplier, privateKeyToAccount(recipientKey(FUNDER_KEY, "supplier")).address);
  assert.notDeepEqual(deriveRecipients(SIGNER_KEY), a);
});

test("a fresh setup plans every step, in order, ownership last", () => {
  const ids = planSetup(fresh()).map((s) => s.id);
  assert.deepEqual(ids, [
    "upload:relay-token",
    "upload:relay-vault",
    "upload:relay-escrow",
    "deploy:token",
    "deploy:vault",
    "link:token",
    "link:vault",
    "mint",
    "approve:supplier",
    "approve:contractor",
    "seed:supplier",
    "seed:contractor",
    "seed:outsider",
    "fund-signer",
    "transfer-ownership",
  ]);
  assert.ok(ids.indexOf("link:vault") < ids.indexOf("seed:supplier"), "linked before seeding");
  assert.equal(planSetup(fresh()).find((s) => s.id === "mint")?.amount, std("1000"));
  assert.deepEqual(blockers(fresh()), []);
});

test("a finished setup plans nothing (idempotent)", () => {
  assert.deepEqual(planSetup(finished()), []);
  assert.deepEqual(blockers(finished()), []);
});

test("a partial run resumes where it stopped", () => {
  const o = finished();
  o.vault = { ...o.vault!, owner: funder, approved: { supplier: true, contractor: false }, balance: std("988") };
  o.seeded = { supplier: `0x${"01".repeat(32)}` };
  o.signerBalance = 0n;
  const ids = planSetup(o).map((s) => s.id);
  assert.deepEqual(ids, ["approve:contractor", "seed:contractor", "seed:outsider", "fund-signer", "transfer-ownership"]);
});

test("the vault is minted only what the remaining seed needs after the first seed", () => {
  const o = finished();
  o.vault = { ...o.vault!, owner: funder, balance: std("100") };
  o.seeded = { supplier: `0x${"01".repeat(32)}` };
  const mint = planSetup(o).find((s) => s.id === "mint");
  assert.equal(mint?.amount, std("157"));
});

test("an unlinked or unaliased contract is linked again; a wrong agent is fixed while the funder owns the vault", () => {
  const o = finished();
  o.token = { ...o.token!, linked: false };
  o.vault = { ...o.vault!, owner: funder, agent: funder };
  assert.deepEqual(
    planSetup(o).map((s) => s.id),
    ["link:token", "set-agent", "transfer-ownership"],
  );
});

test("blockers: different bytecode, foreign owner, wrong agent after handover", () => {
  const o = finished();
  o.uploads["relay-escrow"] = "different";
  o.vault = { ...o.vault!, agent: funder };
  const b = blockers(o);
  assert.ok(b.some((x) => /relay-escrow/.test(x)));
  assert.ok(b.some((x) => /setAgent/.test(x)));
  const f = finished();
  f.vault = { ...f.vault!, owner: getAddress("0x00000000000000000000000000000000000000f0") };
  assert.ok(blockers(f).some((x) => /neither the funder/.test(x)));
});

test("reseed: three owner transfers, top-up and owner gas only when needed", () => {
  const fee = maxFeeFor(1_000_000_000n);
  assert.deepEqual(
    planReseed({ vaultBalance: std("731"), paused: false, ownerIsFunder: false, ownerBalance: parseEther("1"), tokenOwnerIsFunder: true }, fee).map((s) => s.id),
    ["seed:supplier", "seed:contractor", "seed:outsider"],
  );
  const low = planReseed({ vaultBalance: std("200"), paused: false, ownerIsFunder: false, ownerBalance: 0n, tokenOwnerIsFunder: true }, fee);
  assert.deepEqual(low.map((s) => s.id), ["fund-owner", "mint", "seed:supplier", "seed:contractor", "seed:outsider"]);
  assert.equal(low[1].amount, SEED_TOTAL - std("200"));
  assert.throws(() => planReseed({ vaultBalance: 0n, paused: false, ownerIsFunder: true, ownerBalance: 0n, tokenOwnerIsFunder: false }, fee), /can't mint/);
  assert.throws(() => planReseed({ vaultBalance: std("999"), paused: true, ownerIsFunder: true, ownerBalance: 0n, tokenOwnerIsFunder: true }, fee), /paused/);
  assert.equal(SEED_TOTAL, std("269"));
  assert.ok(SEED.some((s) => s.to === "outsider" && std(s.amount) >= std("50")), "one seed transfer is large and unapproved");
});

test("ethNeeded counts gas at the fee cap plus ETH sent", () => {
  const steps = planSetup(fresh());
  const fee = maxFeeFor(10n);
  const need = ethNeeded(steps, fee);
  assert.equal(need.wei, BigInt(need.gas) * fee + parseEther("0.03"));
  assert.ok(need.gas > 1_000_000);
});

test("progress file: fresh when absent, atomic 0600 write, refuses corruption and another funder", () => {
  const dir = tempDir("chain-setup-");
  const file = path.join(dir, "chain-setup.json");
  const p = readProgress(file, 11155111, funder);
  assert.deepEqual(p, emptyProgress(11155111, funder));
  p.pending = { step: "deploy:token", hash: `0x${"aa".repeat(32)}` };
  writeProgress(file, p);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readProgress(file, 11155111, funder).pending, p.pending);
  assert.throws(() => readProgress(file, 1, funder), /another funder or chain/);
  assert.throws(() => readProgress(file, 11155111, signer), /another funder or chain/);
  fs.writeFileSync(file, "{");
  assert.throws(() => readProgress(file, 11155111, funder), /not valid JSON/);
});

test("buildWorkspace produces a valid org/chain.json with the escrow template pinned", () => {
  const { recipients } = deriveRecipients(FUNDER_KEY);
  const h = (n: string) => `0x${n.repeat(32)}` as Hex;
  const ws = buildWorkspace({
    token,
    vault,
    vaultOwner: root,
    deployBlock: 123,
    signer,
    recipients,
    seedTxs: [
      { what: "a", hash: h("01") },
      { what: "a again", hash: h("01") },
      { what: "b", hash: h("02") },
    ],
  });
  assert.deepEqual(parseChainWorkspace(JSON.parse(JSON.stringify(ws))), ws);
  assert.equal(ws.templates.escrow.bytecodeHash, SIMPLE_ESCROW.bytecodeHash);
  assert.equal(ws.templates.escrow.abiHash, SIMPLE_ESCROW.abiHash);
  assert.equal(ws.seed.txs.length, 2, "duplicate hashes dropped");
  assert.equal(ws.monitor.largeTransfer, "50");
  const many = Array.from({ length: 70 }, (_, i) => ({ what: `t${i}`, hash: `0x${i.toString(16).padStart(64, "0")}` as Hex }));
  const capped = buildWorkspace({ token, vault, vaultOwner: root, deployBlock: 1, signer, recipients, seedTxs: many });
  assert.equal(capped.seed.txs.length, 60);
  assert.equal(capped.seed.txs[0].what, "t0");
  assert.equal(capped.seed.txs[59].what, "t69");
  assert.ok(parseChainWorkspace(JSON.parse(JSON.stringify(capped))));
});
