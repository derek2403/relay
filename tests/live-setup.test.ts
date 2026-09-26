import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMIT_WAIT,
  SCRIPT_COMMANDS,
  DRAFT_ROOT_PROBLEM,
  adminState,
  approveAmount,
  commitStorageKey,
  commitWaitLeft,
  companyDefault,
  companyReady,
  companySteps,
  currentCompanyStep,
  draftRootOf,
  draftRootProblem,
  formatTtl,
  funderSummary,
  needsApproval,
  providerSplit,
  registerLabel,
  registerStep,
  resetSummary,
  setupEnvTemplate,
} from "../components/live/setup/setup-model";
import type { StatusResponse } from "../lib/relay/types";

const status = (configured: string[]): StatusResponse =>
  ({
    root: "acme.eth",
    providers: [
      { id: "codex", label: "Codex", configured: configured.includes("codex"), metered: true },
      { id: "github", label: "GitHub", configured: configured.includes("github"), metered: false },
      { id: "mock", label: "Mock", configured: true, metered: true },
    ],
    recordPrefix: "relay",
    dnsAlias: null,
    requireCanonical: true,
    baseUrl: "http://localhost:3000/api/relay",
  }) as StatusResponse;

test("draft root: only a .eth second-level name counts", () => {
  assert.equal(draftRootOf("Acme.eth"), "acme.eth");
  assert.equal(draftRootOf(" acme.eth "), "acme.eth");
  assert.equal(draftRootOf("acme"), null);
  assert.equal(draftRootOf("dev.acme.eth"), null);
  assert.equal(draftRootProblem(""), null);
  assert.equal(draftRootProblem("acme.com"), DRAFT_ROOT_PROBLEM);
  assert.equal(draftRootProblem("acme.eth"), null);
});

test("env template uses the typed root, else a neutral example", () => {
  assert.match(setupEnvTemplate("derek.eth"), /^RELAY_ROOT_NAME=derek\.eth$/m);
  assert.match(setupEnvTemplate(""), /^RELAY_ROOT_NAME=yourcompany\.eth$/m);
  assert.match(setupEnvTemplate("bad"), /^RELAY_ROOT_NAME=yourcompany\.eth$/m);
  assert.match(setupEnvTemplate("derek.eth"), /FUNDER_PRIVATE_KEY=/);
});

test("providers split into with and without a key", () => {
  const { withKey, noKey } = providerSplit(status(["codex"]));
  assert.deepEqual(withKey.map((p) => p.id), ["codex"], "the built-in test API isn't listed");
  assert.deepEqual(noKey.map((p) => p.id), ["github"]);
  assert.deepEqual(providerSplit(undefined), { withKey: [], noKey: [] });
});

test("token lifetime reads in the largest whole unit", () => {
  assert.equal(formatTtl(86_400), "1 d");
  assert.equal(formatTtl(43_200), "12 h");
  assert.equal(formatTtl(1_800), "30 min");
  assert.equal(formatTtl(45), "45 s");
});

test("admin state follows viewAuth and the log probe", () => {
  assert.equal(adminState("open", { ok: false, status: null }), "open");
  assert.equal(adminState("closed", { ok: false, status: null }), "closed");
  assert.equal(adminState("token", { ok: true, status: null }), "signed-in");
  assert.equal(adminState("token", { ok: false, status: 401 }), "signed-out");
  assert.equal(adminState("token", { ok: false, status: 500 }), "unknown");
  assert.equal(adminState(undefined, { ok: false, status: null }), "unknown");
});

test("company default bundle: keyed APIs, capped where dollar caps apply", () => {
  const b = companyDefault(status(["codex"]));
  assert.ok(b.keys.includes("codex"));
  assert.ok(!b.keys.includes("mock"), "the built-in test API isn't offered");
  assert.ok(!b.keys.includes("github"));
  assert.equal(b.period, "month");
  for (const cap of Object.values(b.caps)) assert.equal(cap, 100);
  assert.deepEqual(companyDefault(undefined).keys, []);
});

test("company checklist: ticks and prerequisites", () => {
  const none = { owns: false, resolverDeployed: false, pointed: false, hasLimits: false, editingLimits: false, subnamesDone: false };
  const s0 = companySteps(none);
  assert.deepEqual(s0.map((s) => s.id), ["own", "resolver", "point", "limits", "subnames"]);
  assert.deepEqual(s0.map((s) => s.active), [true, false, false, false, false]);
  assert.equal(currentCompanyStep(s0), "own");

  const owned = { ...none, owns: true };
  assert.deepEqual(companySteps(owned).map((s) => s.active), [true, true, false, false, true]);
  assert.equal(currentCompanyStep(companySteps(owned)), "resolver");

  const pointed = { ...owned, resolverDeployed: true, pointed: true };
  assert.equal(currentCompanyStep(companySteps(pointed)), "limits");
  assert.equal(companySteps(pointed)[3].active, true);

  const all = { ...pointed, hasLimits: true, subnamesDone: true };
  assert.equal(currentCompanyStep(companySteps(all)), null);
  assert.equal(companyReady(all), true);
  // Editing the limits re-opens the step but the company stays ready on chain.
  assert.equal(companySteps({ ...all, editingLimits: true })[3].done, false);
  assert.equal(companyReady({ ...all, subnamesDone: false }), false);
});

test("commit-reveal timing", () => {
  assert.equal(COMMIT_WAIT, 65);
  assert.equal(commitWaitLeft(0, 1_000), null);
  assert.equal(commitWaitLeft(1_000, 0), null);
  assert.equal(commitWaitLeft(1_000, 1_000), 65);
  assert.equal(commitWaitLeft(1_000, 1_060), 5);
  assert.equal(commitWaitLeft(1_000, 1_065), 0);
  assert.equal(commitWaitLeft(1_000, 2_000), 0);
});

test("register step order: resolver, approve, commit, wait, register", () => {
  const base = { resolverDeployed: true, needsApproval: false, commitTime: 0, waitLeft: null };
  assert.equal(registerStep({ ...base, resolverDeployed: false, needsApproval: true }), 0);
  assert.equal(registerStep({ ...base, needsApproval: true }), 1);
  assert.equal(registerStep(base), 2);
  assert.equal(registerStep({ ...base, commitTime: 100, waitLeft: 30 }), 3);
  assert.equal(registerStep({ ...base, commitTime: 100, waitLeft: null }), 3);
  assert.equal(registerStep({ ...base, commitTime: 100, waitLeft: 0 }), 4);
});

test("USDC approval and labels", () => {
  assert.equal(approveAmount(1_000_000n), 1_010_000n);
  assert.equal(needsApproval(undefined, 0n), false);
  assert.equal(needsApproval(100n, undefined), true);
  assert.equal(needsApproval(100n, 100n), false);
  assert.equal(needsApproval(100n, 99n), true);
  assert.equal(registerLabel("Acme"), "acme");
  assert.equal(registerLabel("acme.eth"), "acme");
  assert.equal(registerLabel("dev.acme"), null);
  assert.equal(registerLabel(""), null);
  assert.equal(commitStorageKey("0xabc", "acme"), "ensv2:commit:0xabc:acme");
});

test("funder summary", () => {
  assert.deepEqual(funderSummary(null), { on: false, text: "This relay doesn't report a gas funder." });
  assert.equal(funderSummary({ enabled: true, address: "0x1", amountEth: "0.01", error: null }).text, "On. New members get 0.01 Sepolia ETH for gas.");
  assert.equal(funderSummary({ enabled: false, address: null, amountEth: "0.01", error: "bad key" }).text, "bad key");
  assert.match(funderSummary({ enabled: false, address: null, amountEth: "0.01", error: null }).text, /FUNDER_PRIVATE_KEY/);
});

test("reset summary and script commands", () => {
  assert.equal(resetSummary({ cleared: ["a.acme.eth"], keys: 1, logEntries: 0, skipped: [] }), "Cleared 1 name · 1 spend entry · 0 log entries.");
  assert.equal(
    resetSummary({ cleared: [], keys: 3, logEntries: 2, skipped: [{ name: "x", reason: "y" }] }),
    "Cleared 0 names · 3 spend entries · 2 log entries. 1 name skipped.",
  );
  assert.deepEqual(SCRIPT_COMMANDS.map((c) => c.command), ["npm run org:seed", "npm run demo:reset"]);
});
