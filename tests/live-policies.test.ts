import assert from "node:assert/strict";
import test from "node:test";

import {
  DELEGATABLE,
  type LevelCandidate,
  PLAN_SLUG_ERROR,
  canSetText,
  coversCompany,
  delegateHowTo,
  delegateScope,
  parseDelegate,
  parsePlanSlug,
  pickMyLevel,
  planSlugOf,
  planTarget,
  plansUnder,
  withPlan,
} from "../components/live/policies/policy-logic";
import { ResolverRoles } from "../lib/ens/roles";

test("plan slug: letters, numbers and dashes, normalized", () => {
  assert.deepEqual(parsePlanSlug("standard"), { slug: "standard", error: null });
  assert.deepEqual(parsePlanSlug("Pro-2"), { slug: "pro-2", error: null });
  assert.deepEqual(parsePlanSlug(""), { slug: null, error: null });
  assert.equal(parsePlanSlug("a.b").error, PLAN_SLUG_ERROR);
  assert.equal(parsePlanSlug("a b").slug, null);
  assert.equal(parsePlanSlug("café").error, PLAN_SLUG_ERROR);
});

test("plan target, slug round trip and list under a parent", () => {
  assert.equal(planTarget("standard", "acme.eth"), "plan-standard.acme.eth");
  assert.equal(planTarget("standard", null), null);
  assert.equal(planTarget("bad name", "acme.eth"), null);
  assert.equal(planSlugOf("plan-standard.acme.eth"), "standard");
  assert.equal(planSlugOf("plan-plan-x.eng.acme.eth"), "plan-x");
  const saved = ["plan-a.acme.eth", "plan-b.eng.acme.eth", "plan-c.notacme.eth"];
  assert.deepEqual(plansUnder(saved, "acme.eth"), ["plan-a.acme.eth", "plan-b.eng.acme.eth"]);
  assert.deepEqual(plansUnder(saved, "eng.acme.eth"), ["plan-b.eng.acme.eth"]);
  assert.deepEqual(plansUnder(saved, null), []);
  assert.deepEqual(withPlan(saved, "plan-a.acme.eth"), saved);
  assert.deepEqual(withPlan([], "plan-a.acme.eth"), ["plan-a.acme.eth"]);
});

test("your level: selected owned name with a subregistry, else owned root, else none", () => {
  const sub = "0x0000000000000000000000000000000000000001";
  const root: LevelCandidate = { name: "acme.eth", iOwn: true, subregistry: sub };
  const team: LevelCandidate = { name: "eng.acme.eth", iOwn: true, subregistry: sub };
  assert.equal(pickMyLevel(team, root), team);
  assert.equal(pickMyLevel({ ...team, subregistry: null }, root), root);
  assert.equal(pickMyLevel({ ...team, iOwn: false }, root), root);
  assert.equal(pickMyLevel({ name: null, iOwn: false, subregistry: null }, root), root);
  assert.equal(pickMyLevel(null, root), root);
  assert.equal(pickMyLevel(null, { ...root, iOwn: false }), null);
  assert.equal(pickMyLevel(null, { ...root, subregistry: null }), null);
  assert.equal(pickMyLevel(null, null), null);
});

test("delegates: address parsing, roles and scope text", () => {
  assert.equal(parseDelegate(" 0x000000000000000000000000000000000000dEaD "), "0x000000000000000000000000000000000000dEaD");
  assert.equal(parseDelegate("0x1234"), null);
  assert.equal(parseDelegate(""), null);
  const a = "0x00000000000000000000000000000000000000Aa";
  assert.equal(coversCompany(a, a.toLowerCase() as `0x${string}`), true);
  assert.equal(coversCompany(null, a), false);
  assert.equal(coversCompany(a, undefined), false);
  assert.equal(canSetText(undefined), undefined);
  assert.equal(canSetText(0n), false);
  assert.equal(canSetText(ResolverRoles.ROLE_SET_TEXT), true);
  assert.equal(canSetText(ResolverRoles.ROLE_SET_TEXT_ADMIN), false);
  assert.match(delegateScope(true), /your plans, and the company-wide limit\.$/);
  assert.match(delegateScope(false), /added and your plans\.$/);
  assert.match(delegateHowTo(true), /\(the company row for the company-wide limit\) and use "Change a cap"\.$/);
  assert.equal(delegateHowTo(false), 'They change it from this page: select the name in the team tree and use "Change a cap".');
  assert.ok(DELEGATABLE.length > 0);
  assert.ok(DELEGATABLE.every((p) => p.metered));
});
