import assert from "node:assert/strict";
import test from "node:test";

import {
  type GateFlags,
  activeStep,
  addProblem,
  capValid,
  durationSeconds,
  editRules,
  extendedExpiry,
  fundText,
  labelBadge,
  memberGates,
  memberLabel,
  planLabel,
  plansUnder,
  subnameSteps,
} from "../components/live/members/logic";

const base: GateFlags = {
  connected: true,
  isRoot: false,
  kind: "member",
  active: true,
  expired: false,
  iOwn: false,
  subregistry: null,
  expiry: 2_000_000_000,
  canAddBelow: false,
  canRemove: false,
  canRenew: false,
  canWriteBundle: false,
  canLink: false,
  delegatedCaps: [],
};
const gates = (over: Partial<GateFlags>) => memberGates({ ...base, ...over });

test("owner with a registry they control can add members", () => {
  const g = gates({ iOwn: true, subregistry: "0x1", canAddBelow: true });
  assert.equal(g.add, true);
  assert.equal(g.registryNotMine, false);
  assert.equal(g.enableBelow, false);
  assert.equal(g.nothingToDo, false);
});

test("registry set up by another wallet blocks adding", () => {
  const g = gates({ iOwn: true, subregistry: "0x1", canAddBelow: false });
  assert.equal(g.add, false);
  assert.equal(g.registryNotMine, true);
});

test("own active non-root name without a registry offers 'add names below'", () => {
  assert.equal(gates({ iOwn: true }).enableBelow, true);
  assert.equal(gates({ iOwn: true, active: false }).enableBelow, false);
  assert.equal(gates({ iOwn: true, isRoot: true, kind: "company" }).enableBelow, false);
  assert.equal(gates({ iOwn: true, isRoot: true, kind: "company" }).needsCompanySetup, true);
});

test("level above: edit, plan, extend, remove", () => {
  const g = gates({ canWriteBundle: true, canLink: true, canRenew: true, canRemove: true });
  assert.deepEqual([g.manages, g.editLimits, g.usePlan, g.extend, g.revive, g.remove, g.changeCap], [true, true, true, true, false, true, false]);
  // Agents never get plans.
  assert.equal(gates({ kind: "agent", canWriteBundle: true, canLink: true }).usePlan, false);
  // Unknown kind (roles still loading) doesn't offer plans either.
  assert.equal(gates({ kind: null, canWriteBundle: true, canLink: true }).usePlan, false);
});

test("ended names: bring back only with renew rights", () => {
  const ended = { active: false, expired: true };
  const g = gates({ ...ended, canRenew: true, canRemove: true, canWriteBundle: true });
  assert.equal(g.extend, true);
  assert.equal(g.revive, true);
  assert.equal(g.remove, false);
  assert.equal(g.editLimits, false);
  assert.equal(gates({ ...ended }).endedForGood, true);
});

test("never-expiring names can't be extended", () => {
  assert.equal(gates({ canRenew: true, expiry: 9e12 }).extend, false);
});

test("delegated caps: on a child, and on the root when the wallet can't write the bundle", () => {
  assert.equal(gates({ delegatedCaps: ["codex"] }).changeCap, true);
  assert.equal(gates({ delegatedCaps: ["codex"], canWriteBundle: true }).changeCap, false);
  const root = { isRoot: true, kind: "company" as const };
  assert.equal(gates({ ...root, delegatedCaps: ["codex"] }).changeCap, true);
  assert.equal(gates({ ...root, delegatedCaps: ["codex"], canWriteBundle: true }).changeCap, false);
  assert.equal(gates({ ...root, canWriteBundle: true, canRemove: true }).editLimits, false);
});

test("removed and nothing-to-do notes", () => {
  assert.equal(gates({ active: false, expired: false }).removed, true);
  assert.equal(gates({}).nothingToDo, true);
  assert.equal(gates({ connected: false }).nothingToDo, false);
  assert.equal(gates({ isRoot: true, kind: "company" }).nothingToDo, false);
});

test("labels normalize to one simple label", () => {
  assert.equal(memberLabel("Derek"), "derek");
  assert.equal(memberLabel(" derek "), "derek");
  assert.equal(memberLabel("a.b"), null);
  assert.equal(memberLabel(""), null);
});

test("durations and expiry math", () => {
  assert.equal(durationSeconds(String(30 * 86400), "7"), 30 * 86400);
  assert.equal(durationSeconds("custom", "1.5"), 129600);
  assert.ok(!(durationSeconds("custom", "abc") > 0));
  // Active: counts from the current expiry; ended: from now.
  assert.equal(extendedExpiry(1000, 5000, 3600), 8600);
  assert.equal(extendedExpiry(9000, 5000, 3600), 12600);
  assert.equal(extendedExpiry(1000, null, 10), 1010);
});

test("add-member problems in SRC order, quiet while empty", () => {
  const ok = { labelInput: "derek", label: "derek", ownerInput: "0xabc", owner: "0xabc", seconds: 60, takenByOther: false, childName: "derek.acme.eth", plan: "", bundleError: null, planMissing: false };
  assert.equal(addProblem(ok), null);
  assert.equal(addProblem({ ...ok, labelInput: "", label: null }), null);
  assert.match(addProblem({ ...ok, labelInput: "a.b", label: null })!, /simple label/);
  assert.equal(addProblem({ ...ok, ownerInput: "", owner: null }), null);
  assert.equal(addProblem({ ...ok, ownerInput: "0x12", owner: null }), "That isn't a wallet address.");
  assert.equal(addProblem({ ...ok, seconds: 0 }), "Pick how long.");
  assert.equal(addProblem({ ...ok, takenByOther: true }), "derek.acme.eth is already taken.");
  assert.equal(addProblem({ ...ok, bundleError: "Pick at least one API." }), "Pick at least one API.");
  assert.equal(addProblem({ ...ok, plan: "plan-x.acme.eth", bundleError: "Pick at least one API." }), null);
  assert.match(addProblem({ ...ok, plan: "plan-x.acme.eth", planMissing: true })!, /no limits/);
  assert.deepEqual([labelBadge(false, false), labelBadge(true, false), labelBadge(true, true)], ["free", "registered", "taken"]);
});

test("plans and caps", () => {
  const plans = ["plan-interns.dev.acme.eth", "plan-x.ops.acme.eth"];
  assert.deepEqual(plansUnder(plans, "dev.acme.eth"), ["plan-interns.dev.acme.eth"]);
  assert.equal(planLabel("plan-interns.dev.acme.eth"), "interns");
  assert.equal(capValid(""), true);
  assert.equal(capValid("12.5"), true);
  assert.equal(capValid("-1"), false);
  assert.equal(capValid("x"), false);
});

test("edit rules: stuck on a plan without ROLE_LINK", () => {
  assert.deepEqual(editRules({ canLink: true, canSetAddress: false, kind: "member", readOk: true, linkedPlan: "p" }), { canDetach: true, stuckOnPlan: false });
  assert.deepEqual(editRules({ canLink: true, canSetAddress: false, kind: "agent", readOk: true, linkedPlan: null }), { canDetach: false, stuckOnPlan: false });
  assert.deepEqual(editRules({ canLink: false, canSetAddress: true, kind: "member", readOk: true, linkedPlan: "p" }), { canDetach: false, stuckOnPlan: true });
  assert.deepEqual(editRules({ canLink: false, canSetAddress: true, kind: "member", readOk: false, linkedPlan: null }), { canDetach: false, stuckOnPlan: true });
});

test("subname setup steps and the active one", () => {
  const steps = subnameSteps("dev.acme.eth", { withResolver: true, resolverDeployed: true, deployed: true, attached: false, parentOk: false });
  assert.deepEqual(steps.map((s) => s.key), ["resolver", "registry", "attach", "parent"]);
  assert.equal(activeStep(steps), 2);
  const noResolver = subnameSteps("x", { withResolver: false, resolverDeployed: false, deployed: true, attached: true, parentOk: true });
  assert.equal(noResolver.length, 3);
  assert.equal(activeStep(noResolver), -1);
});

test("fund messages", () => {
  assert.equal(fundText(null), null);
  assert.match(fundText({ status: "sending" })!, /Sending/);
  assert.equal(fundText({ status: "error", message: "boom" }), "No Sepolia ETH sent: boom");
  assert.equal(fundText({ status: "done", result: { funded: false, address: null, reason: "no funder" } }), "No Sepolia ETH sent: no funder");
  assert.match(fundText({ status: "done", result: { funded: true, address: "0x0000000000000000000000000000000000000001", amountEth: "0.01", txHash: "0x1" } })!, /Sent 0.01 Sepolia ETH/);
});
