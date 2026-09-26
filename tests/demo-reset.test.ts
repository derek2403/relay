// npm run demo:reset, offline: flags, which MultiBaas links are relay escrows, the reseed decision,
// the signer top-up threshold, plan limits and the readiness checklist lines.

import assert from "node:assert/strict";
import test from "node:test";

import { type Address, parseEther } from "viem";

import type { MbAddress, MbEvent } from "../lib/multibaas/types";
import {
  ResetArgsError,
  ageText,
  allReady,
  checkLine,
  demoMember,
  escrowLinks,
  linkedSlots,
  needsTopUp,
  newestEventMs,
  parseResetArgs,
  providerCheck,
  shouldReseed,
} from "../scripts/lib/demo-reset";

const TOKEN: Address = "0x00000000000000000000000000000000000000A1";
const VAULT: Address = "0x00000000000000000000000000000000000000A2";
const addr = (alias: string, address: string, labels: string[]): MbAddress => ({
  alias,
  address: address as Address,
  chain: "ethereum",
  contracts: labels.map((label) => ({ label, name: label, version: "1.0" })),
});
const event = (triggeredAt: string) => ({ triggeredAt }) as unknown as MbEvent;
const H = 3600_000;

test("flags: the old ones still work; reseed modes; plan; unknown and contradictory flags refused", () => {
  assert.deepEqual(parseResetArgs([]), { yes: false, keepHome: false, plan: false, reseed: "auto", help: false });
  assert.equal(parseResetArgs(["--yes"]).yes, true);
  assert.equal(parseResetArgs(["-y"]).yes, true);
  assert.equal(parseResetArgs(["--keep-home"]).keepHome, true);
  assert.equal(parseResetArgs(["--reseed"]).reseed, "force");
  assert.equal(parseResetArgs(["--no-reseed"]).reseed, "skip");
  assert.equal(parseResetArgs(["--plan"]).plan, true);
  assert.equal(parseResetArgs(["--dry-run"]).plan, true);
  assert.throws(() => parseResetArgs(["--reseed", "--no-reseed"]), ResetArgsError);
  assert.throws(() => parseResetArgs(["--force"]), /Unknown option --force/);
});

test("escrowLinks: relay-escrow-<n> and relay-escrow links only; token, vault and unlinked addresses stay", () => {
  const links = escrowLinks(
    [
      addr("relay-token", TOKEN, ["relay-token"]),
      addr("relay-vault", VAULT, ["relay-vault"]),
      addr("relay-escrow-1", "0x00000000000000000000000000000000000000E1", ["relay-escrow"]),
      addr("relay-escrow-2", "0x00000000000000000000000000000000000000E2", []), // already unlinked
      addr("", "0x00000000000000000000000000000000000000E3", ["relay-escrow"]), // linked by address only
      addr("someone-else", "0x00000000000000000000000000000000000000E4", ["erc20interface"]),
      addr("vault-copy", VAULT.toLowerCase(), ["relay-escrow"]), // the vault's address: never
    ],
    [TOKEN, VAULT],
  );
  assert.deepEqual(
    links.map((l) => [l.ref, l.labels]),
    [
      ["relay-escrow-1", ["relay-escrow"]],
      ["0x00000000000000000000000000000000000000E3", ["relay-escrow"]],
    ],
  );
});

test("reseed: forced, skipped, or when the newest seeded transfer is over 48 h old (or missing)", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  const events = [event("2026-09-26T12:00:00Z"), event("2026-09-25T00:00:00Z"), event("garbage")];
  assert.equal(newestEventMs(events), Date.parse("2026-09-26T12:00:00Z"));
  assert.equal(newestEventMs([]), null);
  assert.equal(shouldReseed("auto", now - 24 * H, now), false);
  assert.equal(shouldReseed("auto", now - 49 * H, now), true);
  assert.equal(shouldReseed("auto", null, now), true);
  assert.equal(shouldReseed("force", now, now), true);
  assert.equal(shouldReseed("skip", null, now), false);
  assert.equal(ageText(now - 90 * 60_000, now), "1.5 h old");
  assert.equal(ageText(now - 5 * 60_000, now), "5 min old");
  assert.equal(ageText(null, now), "none found");
});

test("signer top-up below 0.01 ETH; linked-contract slots from the plan", () => {
  assert.equal(needsTopUp(parseEther("0.0099")), true);
  assert.equal(needsTopUp(parseEther("0.01")), false);
  assert.deepEqual(linkedSlots({ limits: [{ name: "linked_contracts", limit: 10, count: 9 }] }), { count: 9, limit: 10, free: 1 });
  assert.deepEqual(linkedSlots({ limits: [{ name: "linked_contracts", limit: null }] }), { count: 0, limit: null, free: null });
  assert.equal(linkedSlots({ limits: [] }), null);
});

test("checklist: lines, provider rows, and only ✗ blocks the round", () => {
  assert.equal(checkLine({ ok: true, label: "Relay", detail: "reachable" }), "  ✓ Relay: reachable");
  assert.equal(checkLine({ ok: false, label: "Vault", detail: "10 STD" }), "  ✗ Vault: 10 STD");
  assert.equal(checkLine({ ok: null, label: "Approvals", detail: "" }), "  – Approvals");
  assert.equal(allReady([{ ok: true, label: "a", detail: "" }, { ok: null, label: "b", detail: "" }]), true);
  assert.equal(allReady([{ ok: true, label: "a", detail: "" }, { ok: false, label: "b", detail: "" }]), false);
  const rows = [
    { id: "codex", configured: true },
    { id: "openai-images", configured: false },
    { id: "weather", configured: true },
  ];
  assert.equal(providerCheck("OpenAI", rows, ["codex", "openai-images"]).ok, false);
  assert.equal(providerCheck("Weather", rows, ["weather"]).ok, true);
  assert.equal(providerCheck("Weather", null, ["weather"]).ok, null);
  assert.equal(demoMember("sodalabs.eth"), "derek.cloudops.dev.sodalabs.eth");
});
