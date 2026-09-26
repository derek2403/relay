// Admin portal helpers behind the live view, the team tree and the setup card.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Address, zeroAddress } from "viem";

import { companySetupFirst, inactiveLabel, liveCandidates, liveState, relayTokenCommand } from "./browser";
import type { LevelStatus } from "./types";

const ADMIN: Address = "0x00000000000000000000000000000000000000AD";
const DEREK: Address = "0x0000000000000000000000000000000000000DE1";
const EXTRA: Address = "0x00000000000000000000000000000000000000E7";

const child = (label: string, status: LevelStatus, owner: Address | null) => ({ name: `${label}.dev.eng.acme.eth`, status, owner });
const never = () => false;

test("live view: before step 2 only the admin's launch squad is under dev, so nobody is picked", () => {
  const children = [child("launch", "registered", ADMIN)];
  assert.deepEqual(liveCandidates(children, { admins: [ADMIN, null], seenLive: never }), []);
  // Not connected yet: RELAY_ROOT_OWNER (from the status) still names the admin.
  assert.deepEqual(liveCandidates(children, { admins: [undefined, ADMIN.toLowerCase()], seenLive: never }), []);
  // Malformed admin strings are ignored instead of throwing.
  assert.deepEqual(liveCandidates(children, { admins: ["not-an-address"], seenLive: never }), ["launch.dev.eng.acme.eth"]);
});

test("live view: last rehearsal's removed derek isn't picked on a fresh page", () => {
  const children = [child("launch", "registered", ADMIN), child("derek", "available", null)];
  assert.deepEqual(liveCandidates(children, { admins: [ADMIN], seenLive: never }), []);
});

test("live view: picks the newest user, and keeps one removed while this page watched it", () => {
  const children = [child("launch", "registered", ADMIN), child("derek", "registered", DEREK), child("extra", "registered", EXTRA)];
  assert.deepEqual(liveCandidates(children, { admins: [ADMIN], seenLive: never }), ["extra.dev.eng.acme.eth", "derek.dev.eng.acme.eth"]);

  const removed = [child("launch", "registered", ADMIN), child("derek", "available", null)];
  const seen = (name: string) => name === "derek.dev.eng.acme.eth";
  assert.deepEqual(liveCandidates(removed, { admins: [ADMIN], seenLive: seen }), ["derek.dev.eng.acme.eth"]);
});

test("live state: only a name seen live on this page turns revoked", () => {
  const now = 1_000_000;
  const gone = { status: "available" as const, expiry: now - 5 };
  assert.equal(liveState(gone, undefined, now), "gone");
  assert.equal(liveState(gone, now + 3600, now), "revoked");
  assert.equal(liveState(gone, null, now), "revoked");
  // Its last live expiry passed: it ran out rather than being removed.
  assert.equal(liveState(gone, now - 10, now), "ended");
  assert.equal(liveState({ status: "missing", expiry: null }, now + 3600, now), "revoked");
  assert.equal(liveState({ status: "missing", expiry: null }, undefined, now), "gone");
  assert.equal(liveState({ status: "registered", expiry: now + 60 }, undefined, now), "live");
  assert.equal(liveState({ status: "registered", expiry: now - 1 }, undefined, now), "ended");
  assert.equal(liveState(undefined, undefined, now), "unknown");
});

test("tree badge: unregister clears latestOwner (removed); expiry keeps it (ended)", () => {
  assert.equal(inactiveLabel("user", { latestOwner: zeroAddress, expiry: 1_700_000_000n }), "removed");
  assert.equal(inactiveLabel("agent", { latestOwner: DEREK, expiry: 1_700_000_000n }), "ended");
  assert.equal(inactiveLabel("user", undefined), "not live");
  assert.equal(inactiveLabel("company", undefined), "not registered");
});

test("company setup: a failed read doesn't move setup above the live view", () => {
  const done = { active: true, subregistry: ADMIN, hasBundle: true, loading: false, bundleLoading: false, error: null, bundleError: null };
  assert.equal(companySetupFirst("acme.eth", done), false);
  assert.equal(companySetupFirst(null, done), true);
  // The bundle read was rate-limited: bundle null, not loading, but unknown.
  assert.equal(companySetupFirst("acme.eth", { ...done, hasBundle: false, bundleError: new Error("429") }), false);
  assert.equal(companySetupFirst("acme.eth", { ...done, active: false, error: new Error("429") }), false);
  assert.equal(companySetupFirst("acme.eth", { ...done, hasBundle: false, bundleLoading: true }), false);
  // Read fine and genuinely not set up.
  assert.equal(companySetupFirst("acme.eth", { ...done, hasBundle: false }), true);
  assert.equal(companySetupFirst("acme.eth", { ...done, active: false, subregistry: null, hasBundle: false }), true);
});

test("agent tokens: the ./relay command takes the agent's or subagent's label", () => {
  assert.equal(relayTokenCommand("codex.derek.dev.eng.acme.eth"), "./relay token --as codex");
  assert.equal(relayTokenCommand("research.codex.derek.dev.eng.acme.eth"), "./relay token --as research");
});
