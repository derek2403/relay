// npm run org:seed, offline: the generated spec (determinism and constraints), the derived keys,
// the step plan and its transaction count, expiry and funding math, and demo-reset's keep list.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { type Address, type Hex, concat, keccak256, stringToBytes, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { tryNormalize } from "../lib/ens/names";
import type { Bundle } from "../lib/relay/bundle";
import { UserError, orgPlan } from "../scripts/lib/ensv2";
import {
  AGENT_DAYS,
  DAY,
  DEPARTMENTS,
  GAS,
  ORG_DAYS,
  type OrgSpec,
  PEOPLE,
  ROOT_REGISTRATION,
  type SeedNode,
  deriveKey,
  flattenSpec,
  formatSpec,
  fundingNeed,
  generateSpec,
  niceFloor,
  parseSpec,
  planSteps,
  readSpec,
  renewDue,
  renewTarget,
  resetSweep,
  seedKeys,
  specAliases,
  specPath,
  specProblems,
  summarizePlan,
} from "../scripts/lib/org-seed";

// Anvil's public dev key #0 (only ever used on forks).
const ADMIN_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SEEDS = Array.from({ length: 60 }, (_, i) => (i === 0 ? "sodalabs" : `seed-${i}`));
const parentOf = (name: string) => name.slice(name.indexOf(".") + 1);
const byName = (spec: OrgSpec) => new Map(flattenSpec(spec).map((n) => [n.name, n]));

// --- Generation ------------------------------------------------------------------------------

test("the same seed always makes the same spec; another seed makes another", () => {
  const a = generateSpec("sodalabs");
  assert.deepEqual(a, generateSpec("sodalabs", "sodalabs"));
  assert.equal(formatSpec(a), formatSpec(generateSpec("sodalabs")));
  assert.equal(a.seed, "sodalabs");
  assert.notDeepEqual(generateSpec("sodalabs", "another").departments, a.departments);
  // The label only names the company; the names come from the seed.
  assert.deepEqual(generateSpec("acme", "sodalabs").departments, a.departments);
});

/**
 * Every structural rule of a generated spec (the user's request, word for word where it can be).
 * `edited`: a hand-edited spec (the committed one), whose departments may allow more keys than
 * the generator gives them.
 */
function assertShape(spec: OrgSpec, agentDays = AGENT_DAYS, edited = false) {
  assert.deepEqual(specProblems(spec), [], `seed ${spec.seed}`);
  assert.deepEqual(spec.departments.map((d) => d.label), ["dev", "biz", "mkt"]);
  const people = new Set<string>();
  for (const d of spec.departments) {
    const def = DEPARTMENTS.find((x) => x.label === d.label)!;
    if (edited) for (const k of def.keys) assert.ok(d.bundle.keys.includes(k), `${d.label} allows ${k}`);
    else assert.deepEqual(d.bundle.keys, def.keys);
    assert.ok(d.teams.length >= 1 && d.teams.length <= 2, `${d.label}: ${d.teams.length} teams`);
    assert.equal(new Set(d.teams.map((t) => t.label)).size, d.teams.length);
    for (const t of d.teams) {
      assert.ok(def.teams.includes(t.label), `${t.label} is a ${d.label} team name`);
      assert.ok(t.employees.length >= 1 && t.employees.length <= 2);
      for (const e of t.employees) {
        assert.ok(!people.has(e.label), `${e.label} is unique in the company`);
        people.add(e.label);
        assert.ok(PEOPLE.includes(e.label) && e.label !== "derek" && e.label !== "mia");
        assert.ok(e.bundle.keys.includes("codex"), "every employee can use Codex");
        assert.ok(e.agents.length >= 0 && e.agents.length <= 2);
        assert.equal(new Set(e.agents.map((a) => a.label)).size, e.agents.length);
        for (const a of e.agents) {
          assert.ok(!a.label.includes("relay"));
          assert.ok(a.subagents.length >= 1 && a.subagents.length <= 3);
          assert.equal(new Set(a.subagents.map((s) => s.label)).size, a.subagents.length);
          for (const s of a.subagents) assert.ok(s.label !== "agent" && s.label !== a.label && !s.label.includes("relay"));
        }
      }
    }
  }
  const nodes = flattenSpec(spec);
  const map = new Map(nodes.map((n) => [n.name, n]));
  for (const n of nodes) {
    assert.equal(tryNormalize(n.label), n.label, `${n.label} is a normalized ENS label`);
    assert.ok(/^[a-z]+$/.test(n.label), n.label);
    const agentish = n.kind === "agent" || n.kind === "subagent";
    assert.equal(n.bundle.period, agentish ? "total" : "month", `${n.name} period`);
    assert.equal(n.days, agentish ? agentDays : ORG_DAYS, `${n.name} days`);
    if (!n.parent) continue;
    // Limits only narrow: every key allowed above; dollar caps strictly lower, counts never higher.
    const p = map.get(n.parent)!.bundle;
    for (const k of n.bundle.keys) {
      assert.ok(p.keys.includes(k), `${n.name}: ${k} allowed by ${n.parent}`);
      if (p.caps[k] !== undefined) assert.ok(n.bundle.caps[k]! > 0 && n.bundle.caps[k]! < p.caps[k]!, `${n.name}: ${k} $${n.bundle.caps[k]} < $${p.caps[k]}`);
      if (p.maxes?.[k] !== undefined) assert.ok(n.bundle.maxes![k]! >= 1 && n.bundle.maxes![k]! <= p.maxes[k]!, `${n.name}: ${k} count`);
    }
    for (const k of Object.keys(n.bundle.caps)) assert.ok(n.bundle.keys.includes(k as never));
  }
}

test("generated specs follow the shape: 3 departments, 1-2 teams, 1-2 employees, 0-2 agents, 1-3 subagents, narrowing limits", () => {
  const counts = { agents0: 0, agents2: 0, subs1: 0, subs3: 0, teams1: 0, teams2: 0, images: 0 };
  for (const seed of SEEDS) {
    const spec = generateSpec("sodalabs", seed);
    assertShape(spec);
    for (const n of flattenSpec(spec)) {
      if (n.kind === "department") n.children.length === 1 ? counts.teams1++ : counts.teams2++;
      if (n.kind === "employee") n.children.length === 0 ? counts.agents0++ : n.children.length === 2 && counts.agents2++;
      if (n.kind === "agent") n.children.length === 1 ? counts.subs1++ : n.children.length === 3 && counts.subs3++;
      if (n.kind === "subagent" && n.label === "image") {
        counts.images++;
        assert.deepEqual(n.bundle.keys, ["openai-images"]);
      }
    }
  }
  // Across 60 seeds every end of every range shows up.
  for (const [k, v] of Object.entries(counts)) assert.ok(v > 0, `${k} never generated`);
});

test("--agent-days sets the term of agents and subagents only", () => {
  assertShape(generateSpec("sodalabs", "sodalabs", { agentDays: 7 }), 7);
});

test("the committed org/sodalabs.json is a valid spec with that shape", () => {
  const spec = readSpec(specPath("sodalabs"));
  assert.ok(spec, "org/sodalabs.json exists");
  assert.equal(spec.label, "sodalabs");
  assertShape(spec, AGENT_DAYS, true);
});

test("the committed spec allows weather and OpenAI Images from sodalabs.eth down to cloudops (the one-PAT demo)", () => {
  const nodes = byName(readSpec(specPath("sodalabs"))!);
  const want: [string, number, number][] = [
    ["sodalabs.eth", 10000, 1000],
    ["dev.sodalabs.eth", 5000, 300],
    ["cloudops.dev.sodalabs.eth", 1000, 100],
  ];
  for (const [name, weather, images] of want) {
    const { bundle } = nodes.get(name)!;
    assert.ok(bundle.keys.includes("weather") && bundle.keys.includes("openai-images"), `${name} allows both`);
    assert.equal(bundle.maxes?.weather, weather, `${name} weather requests`);
    assert.equal(bundle.maxes?.["openai-images"], images, `${name} images`);
    assert.equal(bundle.period, "month");
  }
});

test("niceFloor rounds down to 1, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten", () => {
  assert.equal(niceFloor(430), 400);
  assert.equal(niceFloor(159), 150);
  assert.equal(niceFloor(1000), 1000);
  assert.equal(niceFloor(7.3), 6);
  assert.equal(niceFloor(0.9), 0.8);
  assert.equal(niceFloor(0.3), 0.3);
  assert.equal(niceFloor(0.1 * 3), 0.3);
  assert.equal(niceFloor(0), 0);
});

// --- Validation --------------------------------------------------------------------------------

const b = (keys: string[], caps: Record<string, number> = {}, period: Bundle["period"] = "month", maxes: Record<string, number> = {}): Bundle =>
  ({ keys, caps, maxes, period }) as Bundle;

function tinySpec(): OrgSpec {
  return {
    version: 1,
    label: "tiny",
    seed: "tiny",
    root: { days: 365, bundle: b(["codex", "github", "openai-images"], { codex: 100 }, "month", { "openai-images": 50 }) },
    departments: [
      {
        label: "dev",
        days: 365,
        bundle: b(["codex", "github"], { codex: 50 }),
        teams: [
          {
            label: "web",
            days: 365,
            bundle: b(["codex", "github"], { codex: 20 }),
            employees: [
              {
                label: "ana",
                days: 365,
                bundle: b(["codex", "github"], { codex: 10 }),
                agents: [
                  {
                    label: "scout",
                    days: 30,
                    bundle: b(["codex"], { codex: 5 }, "total"),
                    subagents: [
                      { label: "research", days: 30, bundle: b(["codex"], { codex: 2 }, "total") },
                      { label: "docs", days: 30, bundle: b(["codex"], { codex: 1 }, "total") },
                    ],
                  },
                ],
              },
              { label: "ben", days: 365, bundle: b(["codex"], { codex: 5 }), agents: [] },
            ],
          },
        ],
      },
    ],
  };
}

test("specProblems flags labels, duplicates, reserved names, widened limits and bad terms", () => {
  assert.deepEqual(specProblems(tinySpec()), []);
  const broken = tinySpec();
  const team = broken.departments[0].teams[0];
  const ana = team.employees[0];
  ana.bundle = b(["codex", "github", "stripe"], { codex: 30 });
  ana.agents[0].label = "relayer";
  ana.agents[0].subagents[1].label = "agent";
  team.employees[1].label = "Ana";
  team.employees.push({ label: "ben", days: 0, bundle: b(["codex"]), agents: [] });
  const problems = specProblems(broken).join("\n");
  assert.match(problems, /stripe isn't allowed by web\.dev\.tiny\.eth/);
  assert.match(problems, /codex cap \$30, web\.dev\.tiny\.eth caps it at \$20/);
  assert.match(problems, /may not contain "relay"/);
  assert.match(problems, /"agent" is reserved/);
  assert.match(problems, /"Ana" is not a normalized ENS label/);
  assert.match(problems, /days must be a positive number/);
  assert.match(problems, /ben.web.dev.tiny.eth: codex cap missing/);

  const dup = tinySpec();
  dup.departments[0].teams.push({ ...structuredClone(dup.departments[0].teams[0]), label: "api" });
  assert.match(specProblems(dup).join("\n"), /"ana" is also ana\.web\.dev\.tiny\.eth/);
});

test("parseSpec fills missing maxes and throws a UserError listing the problems", () => {
  const text = JSON.stringify(tinySpec(), (k, v) => (k === "maxes" && Object.keys(v).length === 0 ? undefined : v));
  const spec = parseSpec(text);
  assert.deepEqual(flattenSpec(spec).find((n) => n.label === "docs")!.bundle.maxes, {});
  const bad = tinySpec();
  bad.root.bundle.keys.push("nope" as never);
  assert.throws(() => parseSpec(JSON.stringify(bad), "org/tiny.json"), (err: unknown) => err instanceof UserError && /org\/tiny\.json has problems:[\s\S]*unknown keys nope/.test(err.message));
  assert.throws(() => parseSpec("{", "x.json"), UserError);
});

// --- Keys -----------------------------------------------------------------------------------------

test("keys: keccak256(parent key ‖ stringToHex('<org>:<kind>:<name>')), stable and chained", () => {
  const emp = "maya.web.dev.sodalabs.eth";
  const empKey = deriveKey(ADMIN_KEY, "sodalabs", "employee", emp);
  assert.equal(empKey, keccak256(concat([ADMIN_KEY, stringToHex(`sodalabs:employee:${emp}`)])));
  // The string must go in as hex: viem's concat can't mix hex and bytes.
  assert.throws(() => concat([ADMIN_KEY, stringToBytes("sodalabs:employee:x")] as never));
  // Pinned: changing the derivation would orphan every seeded name on chain.
  assert.equal(empKey, "0xafd3434555ba9499e6f6f8c5802b50d764cbac834acd40fac4f85eb9319a4193");
  assert.equal(privateKeyToAccount(empKey).address, "0x17E6Fc2eC2Ef4e8E2CF312490E88C5B0A1Ea2F95");
  const agentKey = deriveKey(empKey, "sodalabs", "agent", `codex.${emp}`);
  assert.equal(privateKeyToAccount(agentKey).address, "0x06bBC7671525DC8c5E027eF924B65d16D66ae200");
  const subKey = deriveKey(agentKey, "sodalabs", "subagent", `research.codex.${emp}`);
  assert.equal(privateKeyToAccount(subKey).address, "0x37C937bB28E3fC2c22dA1e94f1D412Bc4fc44139");
});

test("seedKeys derives employees from the admin, agents from their employee, subagents from their agent", () => {
  const spec = generateSpec("sodalabs");
  const keys = seedKeys(ADMIN_KEY, spec);
  const nodes = flattenSpec(spec);
  const needKeys = nodes.filter((n) => n.kind === "employee" || n.kind === "agent" || n.kind === "subagent");
  assert.equal(keys.size, needKeys.length);
  for (const n of needKeys) {
    const k = keys.get(n.name)!;
    assert.equal(k.kind, n.kind);
    const parentKey = n.kind === "employee" ? ADMIN_KEY : keys.get(n.kind === "agent" ? n.employee! : n.agent!)!.privateKey;
    assert.equal(k.privateKey, keccak256(concat([parentKey, stringToHex(`sodalabs:${n.kind}:${n.name}`)])));
    assert.equal(k.address, privateKeyToAccount(k.privateKey).address);
  }
  assert.equal(new Set([...keys.values()].map((k) => k.address)).size, keys.size, "every name has its own key");
  assert.deepEqual(seedKeys(ADMIN_KEY, spec), keys);
  const other = seedKeys(`0x${"11".repeat(32)}`, spec);
  for (const [name, k] of keys) assert.notEqual(other.get(name)!.address, k.address);
});

// --- The plan ----------------------------------------------------------------------------------------

test("the plan for a small spec: who sends what on a fresh run", () => {
  const spec = tinySpec();
  const steps = planSteps(spec);
  const fresh = steps.filter((s) => s.fresh);
  const s = summarizePlan(spec);
  // admin: its resolver, 3 levels (root: registry, setParent, limits; dev and web: + the entry), 2 employees × (entry, limits)
  assert.equal(s.adminSteps.txs, 1 + 3 + 4 + 4 + 2 * 2);
  assert.deepEqual(s.rootRegistration, ROOT_REGISTRATION);
  assert.equal(s.topUps.txs, 1, "ben has no agents, so he sends nothing and gets no ETH");
  assert.equal(s.admin.txs, 4 + 16 + 1);
  const ana = "ana.web.dev.tiny.eth";
  assert.deepEqual(
    fresh.filter((x) => x.signer === ana).map((x) => `${x.op} ${x.name.split(".")[0]}`),
    [
      "deployResolver ana",
      "deployRegistry ana",
      "setSubregistry ana",
      "setParent ana",
      "deployRegistry scout",
      "register scout",
      "setParent scout",
      "bundle scout",
      "register research",
      "bundle research",
      "register docs",
      "bundle docs",
    ],
  );
  assert.equal(s.perEmployee.get(ana)!.txs, 12);
  assert.equal(s.perEmployee.get("ben.web.dev.tiny.eth")!.txs, 0);
  assert.equal(s.employees.txs, 12);
  assert.equal(s.total.txs, 21 + 12);
  // A subagent's limits: keys, period, one cap and its addr.
  assert.equal(fresh.find((x) => x.id === `bundle:docs.scout.${ana}`)!.gas, GAS.bundleBase + 4 * GAS.bundleRecord);
  assert.equal(s.total.gas, s.admin.gas + s.employees.gas);
  assert.deepEqual(s.names, { company: 1, department: 1, team: 1, employee: 2, agent: 1, subagent: 2, total: 8 });

  // Steps a fresh run doesn't send: done by an earlier step (register attaches the registry) or repairs.
  const notFresh = steps.filter((x) => !x.fresh).map((x) => x.id.split(":")[0]);
  assert.deepEqual([...new Set(notFresh)].sort(), ["clear", "renew", "root-resolver", "sub"]);
  assert.ok(!steps.some((x) => x.signer === "ben.web.dev.tiny.eth"));
});

test("plan: ids are unique, deps exist, and nobody waits on another wallet's step", () => {
  for (const seed of SEEDS.slice(0, 20)) {
    const steps = planSteps(generateSpec("sodalabs", seed));
    const ids = new Map(steps.map((s) => [s.id, s]));
    assert.equal(ids.size, steps.length);
    for (const s of steps) {
      for (const d of s.deps) {
        assert.ok(ids.has(d), `${s.id} waits on ${d}`);
        assert.equal(ids.get(d)!.signer, s.signer, `${s.id} and ${d} have one signer`);
      }
      if (s.signer !== "admin") assert.ok(s.name === s.signer || s.name.endsWith(`.${s.signer}`), `${s.id} is ${s.signer}'s`);
    }
  }
});

test("fresh-run transaction count: 8 + 4 per department/team + 2 per employee + 5 per employee with agents + 4 per agent + 2 per subagent", () => {
  for (const seed of SEEDS) {
    const spec = generateSpec("sodalabs", seed);
    const nodes = flattenSpec(spec);
    const count = (k: SeedNode["kind"]) => nodes.filter((n) => n.kind === k).length;
    const withAgents = nodes.filter((n) => n.kind === "employee" && n.children.length).length;
    const s = summarizePlan(spec);
    assert.equal(s.admin.txs, 4 + 1 + 3 + 4 * (count("department") + count("team")) + 2 * count("employee") + withAgents);
    assert.equal(s.employees.txs, 4 * withAgents + 4 * count("agent") + 2 * count("subagent"));
    assert.equal(s.total.txs, 8 + 4 * (count("department") + count("team")) + 2 * count("employee") + 5 * withAgents + 4 * count("agent") + 2 * count("subagent"));
  }
});

// --- Expiry and gas -------------------------------------------------------------------------------------

test("renewals: only when under a quarter of the term is left, never past the level above", () => {
  const now = 1_800_000_000;
  assert.equal(renewTarget(now, 30), now + 30 * DAY);
  assert.equal(renewTarget(now, 30, now + DAY), now + DAY);
  assert.equal(renewDue(now + 30 * DAY, now, 30), false, "just registered");
  assert.equal(renewDue(now + 8 * DAY, now, 30), false, "8 of 30 days left");
  assert.equal(renewDue(now + 5 * DAY, now, 30), true, "5 of 30 days left");
  assert.equal(renewDue(now + 5 * DAY, now, 30, now + 5 * DAY + 30), false, "the agent above ends then too");
  assert.equal(renewDue(now + 5 * DAY, now, 30, now + 20 * DAY), true);
  assert.equal(renewDue(now + 80 * DAY, now, 365), true);
  assert.equal(renewDue(now + 100 * DAY, now, 365), false);
});

test("fundingNeed pads like Sender (×1.25 + 20k gas per tx) plus 30%", () => {
  const gwei = 1_000_000_000n;
  assert.equal(fundingNeed(1_000_000, 4, gwei), ((1_250_000n + 80_000n) * gwei * 13n) / 10n);
  assert.equal(fundingNeed(0, 0, gwei), 0n);
  // What seeding the committed spec's busiest employee needs at 2 gwei stays well under 0.02 ETH.
  const s = summarizePlan(readSpec(specPath("sodalabs"))!);
  const most = Math.max(...[...s.perEmployee.values()].map((t) => t.gas));
  const txs = Math.max(...[...s.perEmployee.values()].map((t) => t.txs));
  assert.ok(fundingNeed(most, txs, 2n * gwei) < 20_000_000_000_000_000n);
});

// --- demo-reset ---------------------------------------------------------------------------------------------

const MIA: Address = "0x00000000000000000000000000000000000000A1";

test("demo-reset without a seed spec sweeps org-setup's teams and launch squad as before", () => {
  const plan = orgPlan("acme", MIA);
  const sweep = resetSweep(plan, null);
  assert.deepEqual(sweep.map((t) => t.parent), [...plan.teams.map((t) => t.name), plan.launch]);
  for (const t of sweep) {
    assert.equal(t.optional, false);
    assert.equal(t.source, "org-setup");
    assert.deepEqual(t.keep, plan.keep.get(t.parent) ?? new Set());
  }
  assert.deepEqual(sweep.find((t) => t.parent === `dev.eng.acme.eth`)!.keep, new Set(["launch"]));
});

test("demo-reset keeps every seeded employee and removes a developer added live (and so their agents)", () => {
  const spec = generateSpec("sodalabs");
  const plan = orgPlan("sodalabs", MIA);
  const sweep = resetSweep(plan, spec);
  const nodes = byName(spec);
  const teams = [...nodes.values()].filter((n) => n.kind === "team");
  for (const team of teams) {
    const t = sweep.find((x) => x.parent === team.name)!;
    assert.ok(t, `${team.name} is swept`);
    assert.equal(t.source, "org-seed");
    assert.equal(t.optional, false);
    assert.deepEqual(t.keep, new Set(team.children.map((c) => nodes.get(c)!.label)));
    // What demo-reset does with the listing: remove registered labels not kept.
    const children = [...t.keep, "derek"].map((label) => ({ label, status: "registered" }));
    assert.deepEqual(children.filter((c) => c.status === "registered" && !t.keep.has(c.label)).map((c) => c.label), ["derek"]);
  }
  // Only teams are swept: departments, employees and agents are never listed, so nothing seeded below a team is touched.
  const swept = new Set(sweep.map((t) => t.parent));
  for (const n of nodes.values()) if (n.kind !== "team") assert.ok(!swept.has(n.name), `${n.name} isn't swept`);
  // org-setup's levels are still checked, but only if that tree exists next to the seeded one.
  const setup = sweep.filter((t) => t.source === "org-setup");
  assert.equal(setup.length, plan.teams.length + 1);
  assert.ok(setup.every((t) => t.optional));
  assert.deepEqual(setup.find((t) => t.parent === plan.launch)!.keep, new Set(["mia"]));
  assert.ok(parentOf(teams[0].name).endsWith("sodalabs.eth"));
});

test("a spec team that is also an org-setup level keeps both lists", () => {
  const spec = tinySpec();
  const plan = { teams: [{ name: "web.dev.tiny.eth" }], launch: "launch.web.dev.tiny.eth", keep: new Map([["web.dev.tiny.eth", new Set(["launch"])]]) };
  const web = resetSweep(plan, spec).find((t) => t.parent === "web.dev.tiny.eth")!;
  assert.deepEqual(web.keep, new Set(["launch", "ana", "ben"]));
  assert.equal(web.optional, false);
});

// --- Aliases ------------------------------------------------------------------------------------------------

/** tinySpec plus a second department (ops) with a team (sales), and an alias of web.dev.tiny.eth under `parent`. */
function aliasSpec(parent = "ops.tiny.eth", label = "web"): OrgSpec {
  const spec = tinySpec();
  spec.departments.push({
    label: "ops",
    days: 365,
    bundle: b(["codex"], { codex: 40 }),
    teams: [{ label: "sales", days: 365, bundle: b(["codex"], { codex: 10 }), employees: [] }],
  });
  spec.aliases = [{ label, parent, target: "web.dev.tiny.eth", days: 365 }];
  return spec;
}

test("the committed spec lists one alias: cloudops.biz.sodalabs.eth sharing cloudops.dev.sodalabs.eth's registry", () => {
  const spec = readSpec(specPath("sodalabs"))!;
  assert.deepEqual(specAliases(spec), [
    { label: "cloudops", parent: "biz.sodalabs.eth", target: "cloudops.dev.sodalabs.eth", days: ORG_DAYS, name: "cloudops.biz.sodalabs.eth" },
  ]);
  // Not a name of the tree: no bundle, no key, no children of its own.
  assert.ok(!flattenSpec(spec).some((n) => n.name === "cloudops.biz.sodalabs.eth"));
  assert.ok(!seedKeys(ADMIN_KEY, spec).has("cloudops.biz.sodalabs.eth"));
});

test("specProblems checks aliases: label, an admin level as parent, a department or team as target, no loops, no clashes", () => {
  assert.deepEqual(specProblems(aliasSpec()), []);
  assert.deepEqual(specProblems(aliasSpec("sales.ops.tiny.eth")), []);
  const problems = (spec: OrgSpec) => specProblems(spec).join("\n");
  assert.match(problems(aliasSpec("ana.web.dev.tiny.eth")), /parent "ana\.web\.dev\.tiny\.eth" must be the company, a department or a team/);
  assert.match(problems(aliasSpec("nope.tiny.eth")), /parent "nope\.tiny\.eth" must be/);
  assert.match(problems(aliasSpec("dev.tiny.eth")), /the label "web" is already used under dev\.tiny\.eth/);
  assert.match(problems(aliasSpec("web.dev.tiny.eth", "loop")), /can't sit inside its own target/);
  assert.match(problems(aliasSpec("ops.tiny.eth", "Web")), /"Web" is not a normalized ENS label/);
  const toRoot = aliasSpec();
  toRoot.aliases![0].target = "tiny.eth";
  assert.match(problems(toRoot), /target "tiny\.eth" must be a department or a team/);
  const toEmployee = aliasSpec();
  toEmployee.aliases![0].target = "ana.web.dev.tiny.eth";
  assert.match(problems(toEmployee), /target "ana\.web\.dev\.tiny\.eth" must be a department or a team/);
  const twice = aliasSpec();
  twice.aliases!.push({ ...twice.aliases![0] });
  assert.match(problems(twice), /web\.ops\.tiny\.eth: the label "web" is already used under ops\.tiny\.eth/);
  const noDays = aliasSpec();
  noDays.aliases![0].days = 0;
  assert.match(problems(noDays), /web\.ops\.tiny\.eth: days must be a positive number/);
  assert.match(problems({ ...aliasSpec(), aliases: {} as never }), /aliases must be a list/);
});

test("plan: an alias is one admin register, sent once the target's registry points back at the target", () => {
  const spec = aliasSpec();
  const steps = planSteps(spec);
  const alias = steps.filter((s) => s.op === "alias");
  assert.deepEqual(alias, [
    {
      id: "alias:web.ops.tiny.eth",
      signer: "admin",
      op: "alias",
      name: "web.ops.tiny.eth",
      deps: ["reg:ops.tiny.eth", "reg:web.dev.tiny.eth", "parent:web.dev.tiny.eth"],
      fresh: true,
      gas: GAS.alias,
    },
  ]);
  const ids = new Set(steps.map((s) => s.id));
  for (const d of alias[0].deps) assert.ok(ids.has(d), `${d} is a step`);
  const withAlias = summarizePlan(spec);
  const without = summarizePlan({ ...spec, aliases: [] });
  assert.deepEqual(withAlias.aliases, { txs: 1, gas: GAS.alias });
  assert.equal(withAlias.adminSteps.txs, without.adminSteps.txs + 1);
  assert.equal(withAlias.total.txs, without.total.txs + 1);
  assert.deepEqual(withAlias.names, without.names, "an alias isn't counted as a name of the tree");
  assert.deepEqual(summarizePlan(tinySpec()).aliases, { txs: 0, gas: 0 });
});

test("demo-reset keeps an alias registered under a swept team", () => {
  const plan = { teams: [], launch: "launch.nowhere.tiny.eth", keep: new Map<string, Set<string>>() };
  const sales = resetSweep(plan, aliasSpec("sales.ops.tiny.eth")).find((t) => t.parent === "sales.ops.tiny.eth")!;
  assert.deepEqual(sales.keep, new Set(["web"]));
  // An alias under a department isn't in a swept registry at all (only teams are swept).
  for (const t of resetSweep(plan, aliasSpec())) assert.ok(!t.keep.has("web"), `${t.parent} keeps nothing called web`);
});

test("aliases round-trip through formatSpec and parseSpec", () => {
  const spec = aliasSpec();
  const text = formatSpec(spec);
  assert.match(text, /"aliases": \[\n {4}\{\n {6}"label": "web",\n {6}"parent": "ops\.tiny\.eth",\n {6}"target": "web\.dev\.tiny\.eth",\n {6}"days": 365\n {4}\}\n {2}\]/);
  assert.deepEqual(parseSpec(text), spec);
  // The committed file is exactly what formatSpec writes.
  const committed = fs.readFileSync(specPath("sodalabs"), "utf8");
  assert.equal(formatSpec(parseSpec(committed)), committed);
});

test("the spec file round-trips through formatSpec (bundles on one line)", () => {
  const spec = generateSpec("sodalabs", "roundtrip");
  const text = formatSpec(spec);
  assert.deepEqual(parseSpec(text), spec);
  assert.match(text, /"bundle": \{"keys": \[/);
  assert.ok(!fs.existsSync(specPath("roundtrip")));
});

test("org/sodalabs.json: every chain grant's gas cap covers an escrow deploy (~845k gas measured on anvil)", () => {
  const spec = JSON.parse(fs.readFileSync(new URL("../org/sodalabs.json", import.meta.url), "utf8"));
  const gases: [string, number][] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    const chain = o.chain as { gas?: string } | undefined;
    if (chain && typeof chain === "object" && chain.gas !== undefined) gases.push([path, Number(chain.gas)]);
    for (const [k, v] of Object.entries(o)) if (k !== "chain") walk(v, `${path}.${k}`);
  };
  walk(spec, "spec");
  assert.ok(gases.length >= 3, `found ${gases.length} chain grants`);
  for (const [where, gas] of gases) assert.ok(gas >= 1_000_000, `${where}: gas ${gas} is below an escrow deploy (844,655)`);
});
