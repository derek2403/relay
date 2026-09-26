// The seeded company (npm run org:seed): the spec file org/<label>.json, its deterministic
// generator, the keys derived for employees, agents and subagents, the step plan (who sends
// what, used for --plan and for funding the employees) and demo-reset's keep list.
//
// Pure apart from reading and writing the spec file: nothing here talks to the chain, so the
// tests (tests/org-seed.test.ts) run offline.
//
// Relative imports only (like ensv2.ts).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { type Address, type Hex, concat, keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { tryNormalize } from "../../lib/ens/names";
import { type Bundle, PERIODS, PROVIDER_IDS, type Period, type ProviderId, describeBundle, isProviderId } from "../../lib/relay/bundle";
import { REPO_ROOT, UserError } from "./ensv2";

export const DAY = 86_400;
export const SPEC_VERSION = 1;
export const DEFAULT_ORG = "sodalabs";
/** Company, departments, teams and employees. */
export const ORG_DAYS = 365;
/** Agents and subagents: long enough that the tree survives between demos. */
export const AGENT_DAYS = 30;

// --- The spec -------------------------------------------------------------------------------

export type SpecLevel = { label: string; days: number; bundle: Bundle };
export type SpecSubagent = SpecLevel;
export type SpecAgent = SpecLevel & { subagents: SpecSubagent[] };
export type SpecEmployee = SpecLevel & { agents: SpecAgent[] };
export type SpecTeam = SpecLevel & { employees: SpecEmployee[] };
export type SpecDepartment = SpecLevel & { teams: SpecTeam[] };

export type OrgSpec = {
  $comment?: string;
  version: typeof SPEC_VERSION;
  /** The company's .eth label ("sodalabs" for sodalabs.eth). */
  label: string;
  /** What the names were generated from (npm run org:seed -- --regenerate --seed <seed>). */
  seed: string;
  root: { days: number; bundle: Bundle };
  departments: SpecDepartment[];
};

export type SeedKind = "company" | "department" | "team" | "employee" | "agent" | "subagent";

/** One name of the spec, flattened (tree order: every name before its children). */
export type SeedNode = {
  name: string;
  label: string;
  parent: string | null;
  kind: SeedKind;
  days: number;
  bundle: Bundle;
  /** The employee this name belongs to (itself for an employee), else null. */
  employee: string | null;
  /** The agent above a subagent (itself for an agent), else null. */
  agent: string | null;
  children: string[];
};

export function flattenSpec(spec: OrgSpec): SeedNode[] {
  const root = `${spec.label}.eth`;
  const nodes: SeedNode[] = [];
  const add = (n: Omit<SeedNode, "children">) => {
    const node = { ...n, children: [] as string[] };
    if (n.parent) nodes.find((p) => p.name === n.parent)?.children.push(n.name);
    nodes.push(node);
    return node;
  };
  add({ name: root, label: spec.label, parent: null, kind: "company", days: spec.root.days, bundle: spec.root.bundle, employee: null, agent: null });
  for (const d of spec.departments) {
    const dept = add({ name: `${d.label}.${root}`, label: d.label, parent: root, kind: "department", days: d.days, bundle: d.bundle, employee: null, agent: null });
    for (const t of d.teams) {
      const team = add({ name: `${t.label}.${dept.name}`, label: t.label, parent: dept.name, kind: "team", days: t.days, bundle: t.bundle, employee: null, agent: null });
      for (const e of t.employees) {
        const empName = `${e.label}.${team.name}`;
        add({ name: empName, label: e.label, parent: team.name, kind: "employee", days: e.days, bundle: e.bundle, employee: empName, agent: null });
        for (const a of e.agents) {
          const agentName = `${a.label}.${empName}`;
          add({ name: agentName, label: a.label, parent: empName, kind: "agent", days: a.days, bundle: a.bundle, employee: empName, agent: agentName });
          for (const s of a.subagents) {
            add({ name: `${s.label}.${agentName}`, label: s.label, parent: agentName, kind: "subagent", days: s.days, bundle: s.bundle, employee: empName, agent: agentName });
          }
        }
      }
    }
  }
  return nodes;
}

/** The admin's levels: company, departments and teams. */
export const isOrgLevel = (n: SeedNode) => n.kind === "company" || n.kind === "department" || n.kind === "team";

// --- Generation (deterministic from a seed) -------------------------------------------------------

/** Numbers from sha256(seed:counter): the same seed gives the same org on every machine and Node version. */
export class Rng {
  private n = 0;
  constructor(readonly seed: string) {}
  next(): number {
    return createHash("sha256").update(`${this.seed}:${this.n++}`).digest().readUInt32BE(0) / 0x1_0000_0000;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  /** `k` distinct items, in the order drawn. */
  sample<T>(items: readonly T[], k: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    while (out.length < k && pool.length) out.push(pool.splice(Math.floor(this.next() * pool.length), 1)[0]);
    return out;
  }
}

type DeptDef = {
  label: string;
  keys: ProviderId[];
  caps: Partial<Record<ProviderId, number>>;
  maxes: Partial<Record<ProviderId, number>>;
  teams: string[];
  /** Subagent roles for this department's agents. */
  roles: string[];
};

export const ROOT_BUNDLE: Bundle = {
  keys: [...PROVIDER_IDS],
  caps: { claude: 1000, codex: 2000, gemini: 300 },
  maxes: { "openai-images": 1000, stripe: 10000 },
  period: "month",
};

export const DEPARTMENTS: DeptDef[] = [
  {
    label: "dev",
    keys: ["codex", "claude", "github", "railway", "vercel", "linear"],
    caps: { codex: 1000, claude: 600 },
    maxes: {},
    teams: ["cloudops", "web", "mobile", "infra", "data", "platform"],
    roles: ["research", "review", "tests", "docs", "triage", "deploy", "lint"],
  },
  {
    label: "biz",
    keys: ["stripe", "notion", "slack", "hubspot", "codex"],
    caps: { codex: 200 },
    maxes: { stripe: 5000 },
    teams: ["sales", "finance", "legal", "partnerships", "ops"],
    roles: ["research", "review", "docs", "triage", "summary", "invoices", "outreach"],
  },
  {
    label: "mkt",
    keys: ["canva", "hubspot", "mailchimp", "gemini", "openai-images", "codex"],
    caps: { codex: 300, gemini: 150 },
    maxes: { "openai-images": 500 },
    teams: ["growth", "content", "brand", "social", "events"],
    roles: ["research", "review", "image", "copy", "seo", "posts", "docs"],
  },
];

/** First names for employees (never "derek" or "mia": the demo adds those live or through org-setup). */
export const PEOPLE = [
  "maya", "leo", "aria", "noah", "zara", "kai", "ivy", "omar", "lena", "theo", "nina", "ravi", "mila", "finn",
  "sana", "eli", "yuki", "hana", "marco", "jade", "arjun", "chloe", "diego", "emma", "felix", "grace", "hugo",
  "iris", "jonas", "kira", "lucas", "mei", "nora", "oscar", "priya", "quinn", "rosa", "tara", "victor", "wren",
];

/** AI keys an agent can run on; an agent may be named after the one it uses. */
export const AI_KEYS: ProviderId[] = ["codex", "claude", "gemini"];
export const AGENT_NAMES = ["scout", "atlas", "pilot", "nova", "echo", "sage", "orbit", "juno", "kite", "ember", "quill", "rook", "lark", "onyx"];
/** A tool key a subagent in this role also gets, when its agent has it. */
const ROLE_TOOLS: Record<string, ProviderId[]> = {
  deploy: ["vercel", "railway"],
  triage: ["linear", "github", "hubspot"],
  review: ["github"],
  tests: ["github"],
  lint: ["github"],
  docs: ["notion"],
  invoices: ["stripe"],
  outreach: ["hubspot", "mailchimp"],
  summary: ["slack"],
  posts: ["canva"],
};

const NICE = [8, 6, 5, 4, 3, 2.5, 2, 1.5, 1];

/** The largest "nice" number (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 times a power of ten) not above x. */
export function niceFloor(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const base = 10 ** Math.floor(Math.log10(x));
  const m = x / base;
  const pick = NICE.find((n) => n <= m + 1e-9) ?? 1;
  return Number((pick * base).toPrecision(6));
}

/** `keys` (in the parent's order) with every limit the parent sets, each a share of the parent's. */
function narrowed(rng: Rng, parent: Bundle, keys: ProviderId[], share: [number, number], period: Period): Bundle {
  const ordered = parent.keys.filter((k) => keys.includes(k));
  const caps: Bundle["caps"] = {};
  const maxes: NonNullable<Bundle["maxes"]> = {};
  for (const k of ordered) {
    const cap = parent.caps[k];
    if (cap !== undefined) caps[k] = Math.min(cap, niceFloor(cap * rng.between(...share)) || cap);
    const max = parent.maxes?.[k];
    if (max !== undefined) maxes[k] = Math.min(max, Math.max(1, Math.floor(niceFloor(max * rng.between(...share)))));
  }
  return { keys: ordered, caps, maxes, period };
}

/** `must` plus a random subset of the other keys: at least `share` of them (and at least one). */
function someKeys(rng: Rng, from: ProviderId[], must: ProviderId[], share: number): ProviderId[] {
  const rest = from.filter((k) => !must.includes(k));
  const n = rest.length ? rng.int(Math.max(1, Math.ceil(rest.length * share)), rest.length) : 0;
  return [...must.filter((k) => from.includes(k)), ...rng.sample(rest, n)];
}

export const SPEC_COMMENT =
  "Made by npm run org:seed. Edit labels, bundles (relay.* records) and days freely, then run npm run org:seed again: " +
  "it only sends what is missing. npm run demo:reset keeps every name listed here. Docs: docs/org-seed.md";

/**
 * A company with departments dev, biz and mkt; 1-2 teams each; 1-2 employees per team (first
 * names, unique in the company); 0-2 agents per employee; 1-3 subagents per agent. Limits only
 * narrow going down; agents and subagents count in "total" and live `agentDays`.
 */
export function generateSpec(org: string, seed: string = org, opts: { agentDays?: number; orgDays?: number } = {}): OrgSpec {
  const rng = new Rng(seed);
  const orgDays = opts.orgDays ?? ORG_DAYS;
  const agentDays = opts.agentDays ?? AGENT_DAYS;
  const people = new Set<string>();

  const departments = DEPARTMENTS.map((d): SpecDepartment => {
    const deptBundle: Bundle = { keys: [...d.keys], caps: { ...d.caps }, maxes: { ...d.maxes }, period: "month" };
    const teams = rng.sample(d.teams, rng.int(1, 2)).map((teamLabel): SpecTeam => {
      const teamBundle = narrowed(rng, deptBundle, someKeys(rng, deptBundle.keys, ["codex"], 0.5), [0.3, 0.6], "month");
      const employees = Array.from({ length: rng.int(1, 2) }, (): SpecEmployee => {
        const label = rng.pick(PEOPLE.filter((p) => !people.has(p)));
        people.add(label);
        const empBundle = narrowed(rng, teamBundle, someKeys(rng, teamBundle.keys, ["codex"], 0.5), [0.15, 0.4], "month");
        const aiKeys = empBundle.keys.filter((k) => AI_KEYS.includes(k));
        const tools = empBundle.keys.filter((k) => !AI_KEYS.includes(k) && k !== "openai-images");
        const agentLabels = new Set<string>();
        const agents = Array.from({ length: rng.int(0, 2) }, (): SpecAgent => {
          const named = aiKeys.filter((k) => !agentLabels.has(k));
          const label = named.length && rng.chance(0.5) ? rng.pick(named) : rng.pick(AGENT_NAMES.filter((n) => !agentLabels.has(n)));
          agentLabels.add(label);
          const primary = (AI_KEYS as string[]).includes(label) ? (label as ProviderId) : rng.pick(aiKeys);
          const keys: ProviderId[] = [primary];
          if (empBundle.keys.includes("openai-images") && rng.chance(0.6)) keys.push("openai-images");
          if (tools.length && rng.chance(0.5)) keys.push(rng.pick(tools));
          const agentBundle = narrowed(rng, empBundle, keys, [0.1, 0.3], "total");
          const roles = d.roles.filter((r) => r !== label && r !== "agent" && (r !== "image" || agentBundle.keys.includes("openai-images")));
          const subagents = rng.sample(roles, rng.int(1, 3)).map((role): SpecSubagent => {
            const tool = (ROLE_TOOLS[role] ?? []).find((k) => agentBundle.keys.includes(k));
            const subKeys: ProviderId[] = role === "image" ? ["openai-images"] : [primary, ...(tool ? [tool] : [])];
            return { label: role, days: agentDays, bundle: narrowed(rng, agentBundle, subKeys, [0.2, 0.5], "total") };
          });
          return { label, days: agentDays, bundle: agentBundle, subagents };
        });
        return { label, days: orgDays, bundle: empBundle, agents };
      });
      return { label: teamLabel, days: orgDays, bundle: teamBundle, employees };
    });
    return { label: d.label, days: orgDays, bundle: deptBundle, teams };
  });

  return {
    $comment: SPEC_COMMENT,
    version: SPEC_VERSION,
    label: org,
    seed,
    root: { days: orgDays, bundle: { ...ROOT_BUNDLE, keys: [...ROOT_BUNDLE.keys], caps: { ...ROOT_BUNDLE.caps }, maxes: { ...ROOT_BUNDLE.maxes } } },
    departments,
  };
}

// --- Validation --------------------------------------------------------------------------------------

const isLabel = (label: unknown): label is string => typeof label === "string" && !!label && !label.includes(".") && tryNormalize(label) === label;

function bundleProblems(b: Bundle | undefined, name: string): string[] {
  if (!b || typeof b !== "object" || !Array.isArray(b.keys)) return [`${name}: no bundle (keys, caps, period)`];
  const out: string[] = [];
  if (!b.keys.length) out.push(`${name}: the bundle lists no keys`);
  const bad = b.keys.filter((k) => !isProviderId(k));
  if (bad.length) out.push(`${name}: unknown keys ${bad.join(", ")} (see lib/relay/catalog.ts)`);
  if (new Set(b.keys).size !== b.keys.length) out.push(`${name}: a key is listed twice`);
  if (!(PERIODS as readonly string[]).includes(b.period)) out.push(`${name}: period must be ${PERIODS.join(", ")}`);
  for (const [field, limits, integer] of [
    ["caps", b.caps ?? {}, false],
    ["maxes", b.maxes ?? {}, true],
  ] as const) {
    for (const [k, v] of Object.entries(limits)) {
      if (!b.keys.includes(k as ProviderId)) out.push(`${name}: ${field}.${k} is set but ${k} isn't in keys`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) out.push(`${name}: ${field}.${k} must be a ${integer ? "whole " : ""}number ≥ 0`);
    }
  }
  return out;
}

/** A child may only narrow: every key allowed above, and every limit set above set here too, no higher. */
export function narrowingProblems(child: Bundle, parent: Bundle, name: string, parentName: string): string[] {
  const out: string[] = [];
  for (const k of child.keys) {
    if (!parent.keys.includes(k)) {
      out.push(`${name}: ${k} isn't allowed by ${parentName}`);
      continue;
    }
    const cap = parent.caps[k];
    const mine = child.caps[k];
    if (cap !== undefined && (mine === undefined || mine > cap)) out.push(`${name}: ${k} cap ${mine === undefined ? "missing" : `$${mine}`}, ${parentName} caps it at $${cap}`);
    const max = parent.maxes?.[k];
    const own = child.maxes?.[k];
    if (max !== undefined && (own === undefined || own > max)) out.push(`${name}: ${k} count ${own === undefined ? "missing" : own}, ${parentName} allows ${max}`);
  }
  return out;
}

/** Everything wrong with a spec (empty when it is usable). */
export function specProblems(spec: OrgSpec): string[] {
  const out: string[] = [];
  if (spec.version !== SPEC_VERSION) out.push(`version must be ${SPEC_VERSION}`);
  if (!isLabel(spec.label)) out.push(`label "${spec.label}" must be one normalized ENS label, like "sodalabs"`);
  if (!spec.root || !Array.isArray(spec.departments)) return [...out, "the spec needs root and departments"];
  const root = `${spec.label}.eth`;
  const people = new Map<string, string>();
  const checkLevel = (level: SpecLevel, name: string, parent: { bundle: Bundle; name: string } | null, siblings: Set<string>, kind: SeedKind) => {
    if (!isLabel(level.label)) out.push(`${name}: "${level.label}" is not a normalized ENS label`);
    if (siblings.has(level.label)) out.push(`${name}: the label "${level.label}" is used twice here`);
    siblings.add(level.label);
    if (!(typeof level.days === "number" && Number.isFinite(level.days) && level.days > 0)) out.push(`${name}: days must be a positive number`);
    const problems = bundleProblems(level.bundle, name);
    out.push(...problems);
    if (!problems.length && parent) out.push(...narrowingProblems(level.bundle, parent.bundle, name, parent.name));
    if ((kind === "agent" || kind === "subagent") && level.label.includes("relay")) out.push(`${name}: agent names may not contain "relay"`);
  };
  checkLevel({ label: spec.label, days: spec.root.days, bundle: spec.root.bundle }, root, null, new Set(), "company");
  const depts = new Set<string>();
  for (const d of spec.departments) {
    const dn = `${d.label}.${root}`;
    checkLevel(d, dn, { bundle: spec.root.bundle, name: root }, depts, "department");
    const teams = new Set<string>();
    for (const t of d.teams ?? []) {
      const tn = `${t.label}.${dn}`;
      checkLevel(t, tn, { bundle: d.bundle, name: dn }, teams, "team");
      const employees = new Set<string>();
      for (const e of t.employees ?? []) {
        const en = `${e.label}.${tn}`;
        checkLevel(e, en, { bundle: t.bundle, name: tn }, employees, "employee");
        if (people.has(e.label) && people.get(e.label) !== en) out.push(`${en}: "${e.label}" is also ${people.get(e.label)} (employee labels are unique in the company)`);
        people.set(e.label, en);
        const agents = new Set<string>();
        for (const a of e.agents ?? []) {
          const an = `${a.label}.${en}`;
          checkLevel(a, an, { bundle: e.bundle, name: en }, agents, "agent");
          const subs = new Set<string>();
          for (const s of a.subagents ?? []) {
            const sn = `${s.label}.${an}`;
            checkLevel(s, sn, { bundle: a.bundle, name: an }, subs, "subagent");
            if (s.label === "agent" || s.label === a.label) out.push(`${sn}: "${s.label}" is reserved under ${an} (./relay uses it for the agent itself)`);
          }
        }
      }
    }
  }
  return out;
}

// --- The spec file ---------------------------------------------------------------------------------

export const specPath = (label: string, repo = REPO_ROOT) => path.join(repo, "org", `${label}.json`);

/** Labels of the specs in org/ (org/<label>.json). */
export function listSpecs(repo = REPO_ROOT): string[] {
  try {
    return fs
      .readdirSync(path.join(repo, "org"))
      .filter((f) => /^[^.]+\.json$/.test(f))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

/** Parses a spec (missing maxes become {}), throwing a UserError that lists every problem. */
export function parseSpec(text: string, file = "the spec"): OrgSpec {
  let raw: OrgSpec;
  try {
    raw = JSON.parse(text) as OrgSpec;
  } catch (err) {
    throw new UserError(`${file} is not valid JSON (${(err as Error).message}).`);
  }
  const fix = (b: Bundle | undefined) => b && typeof b === "object" && (b.caps ??= {}) && (b.maxes ??= {});
  fix(raw?.root?.bundle);
  for (const d of raw?.departments ?? []) {
    fix(d.bundle);
    d.teams ??= [];
    for (const t of d.teams) {
      fix(t.bundle);
      t.employees ??= [];
      for (const e of t.employees) {
        fix(e.bundle);
        e.agents ??= [];
        for (const a of e.agents) {
          fix(a.bundle);
          a.subagents ??= [];
          for (const s of a.subagents) fix(s.bundle);
        }
      }
    }
  }
  const problems = specProblems(raw);
  if (problems.length) throw new UserError(`${file} has problems:\n  - ${problems.join("\n  - ")}`);
  return raw;
}

/** org/<label>.json, or null when there is none. */
export function readSpec(file: string): OrgSpec | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return parseSpec(text, path.relative(REPO_ROOT, file) || file);
}

/** The spec for `org` in org/, if there is one (demo-reset's keep list). */
export const loadSeedSpec = (org: string, repo = REPO_ROOT) => readSpec(specPath(org, repo));

const inline = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(inline).join(", ")}]`;
  if (v && typeof v === "object") return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")}}`;
  return JSON.stringify(v);
};

/** A bundle on one line, with its fields in a fixed order (maxes only when set). */
const bundleJson = (b: Bundle) => inline({ keys: b.keys, caps: b.caps, ...(Object.keys(b.maxes ?? {}).length ? { maxes: b.maxes } : {}), period: b.period });

/** The spec as JSON with every bundle on one line (readable and diff-friendly). */
export function formatSpec(spec: OrgSpec): string {
  const pretty = (v: unknown, indent: string): string => {
    if (Array.isArray(v)) {
      if (!v.length) return "[]";
      return `[\n${v.map((x) => `${indent}  ${pretty(x, `${indent}  `)}`).join(",\n")}\n${indent}]`;
    }
    if (v && typeof v === "object") {
      const lines = Object.entries(v).map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${k === "bundle" ? bundleJson(x as Bundle) : pretty(x, `${indent}  `)}`);
      return `{\n${lines.join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(v);
  };
  return `${pretty(spec, "")}\n`;
}

export function writeSpec(file: string, spec: OrgSpec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, formatSpec(spec));
}

// --- Keys --------------------------------------------------------------------------------------------

export type SeedKey = { name: string; kind: "employee" | "agent" | "subagent"; privateKey: Hex; address: Address };

/**
 * keccak256(parentKey ‖ "<org>:<kind>:<full name>"), like miaAccount. The string goes in as hex
 * (stringToHex): viem's concat can't mix hex and bytes. Employees derive from the admin key,
 * agents from their employee's key, subagents from their agent's key, so whoever holds a key
 * can re-derive everything below it and nothing above.
 */
export const deriveKey = (parentKey: Hex, org: string, kind: SeedKey["kind"], name: string): Hex =>
  keccak256(concat([parentKey, stringToHex(`${org}:${kind}:${name}`)]));

/** Every derived key of the spec, by full name. */
export function seedKeys(adminKey: Hex, spec: OrgSpec): Map<string, SeedKey> {
  const keys = new Map<string, SeedKey>();
  const put = (name: string, kind: SeedKey["kind"], privateKey: Hex) => {
    const key = { name, kind, privateKey, address: privateKeyToAccount(privateKey).address };
    keys.set(name, key);
    return key;
  };
  for (const n of flattenSpec(spec)) {
    if (n.kind === "employee") put(n.name, "employee", deriveKey(adminKey, spec.label, "employee", n.name));
    else if (n.kind === "agent") put(n.name, "agent", deriveKey(keys.get(n.employee!)!.privateKey, spec.label, "agent", n.name));
    else if (n.kind === "subagent") put(n.name, "subagent", deriveKey(keys.get(n.agent!)!.privateKey, spec.label, "subagent", n.name));
  }
  return keys;
}

// --- The plan: every step, who signs it, and its gas --------------------------------------------------

/**
 * Gas per call, a little above what fork runs used (./relay login ≈ 1.2M for its 8 calls, a
 * subagent ≈ 0.35M), so employees get enough. Only for --plan and for funding: the real run
 * estimates each transaction before sending it.
 */
export const GAS = {
  deployResolver: 260_000,
  deployRegistry: 240_000,
  register: 240_000,
  setSubregistry: 45_000,
  setResolver: 45_000,
  setParent: 60_000,
  renew: 40_000,
  unregister: 60_000,
  bundleBase: 35_000,
  bundleRecord: 30_000,
  transfer: 21_000,
  mintUsdc: 70_000,
  approveUsdc: 50_000,
  commit: 50_000,
  registerEth: 400_000,
} as const;

/** Registering <org>.eth: mint MockUSDC, approve, commit, register. */
export const ROOT_REGISTRATION = { txs: 4, gas: GAS.mintUsdc + GAS.approveUsdc + GAS.commit + GAS.registerEth };

export type SeedOp = "deployResolver" | "deployRegistry" | "register" | "setSubregistry" | "setResolver" | "setParent" | "bundle" | "renew" | "unregister";

export type PlannedStep = {
  id: string;
  /** "admin", or the full name of the employee whose wallet sends it. */
  signer: string;
  op: SeedOp;
  /** The name the step is about. */
  name: string;
  deps: string[];
  /** A fresh run sends it (false: done by an earlier step, or only needed to repair or renew). */
  fresh: boolean;
  gas: number;
};

/** Text records a bundle write sets on a new name (plus addr for agents and subagents). */
export const bundleRecords = (n: Pick<SeedNode, "bundle" | "kind">) =>
  2 + Object.keys(n.bundle.caps).length + Object.keys(n.bundle.maxes ?? {}).length + (n.kind === "agent" || n.kind === "subagent" ? 1 : 0);

const gasOf = (op: SeedOp, n: SeedNode) => (op === "bundle" ? GAS.bundleBase + GAS.bundleRecord * bundleRecords(n) : GAS[op]);

/**
 * Every step after the root registration, in the order org-setup, the portal's Add a member,
 * ./relay login and ./relay subagent create would send them:
 *  - admin: its resolver; per company/department/team a registry (Verifiable Factory), the entry
 *    (register with its registry attached, ROLE_SET_SUBREGISTRY), setSubregistry, setParent, the
 *    bundle on the admin's resolver; per employee the entry (owner = the employee's wallet,
 *    ROLE_SET_SUBREGISTRY, no registry yet) and the bundle.
 *  - each employee with agents (own wallet): its resolver and registry, setSubregistry under its
 *    name, setParent; per agent a registry, the entry (owner = agent key, no roles, registry
 *    attached), setParent, the bundle + addr on the employee's resolver; per subagent the entry
 *    in the agent's registry (owner = subagent key, no roles) and its bundle + addr.
 * "clear" (unregister a label held by another key) and "renew" only send when needed.
 */
export function planSteps(spec: OrgSpec): PlannedStep[] {
  const nodes = flattenSpec(spec);
  const steps: PlannedStep[] = [];
  const add = (signer: string, op: SeedOp, n: SeedNode, id: string, deps: string[] = [], fresh = true) =>
    steps.push({ id, signer, op, name: n.name, deps, fresh, gas: gasOf(op, n) });
  const [root] = nodes;

  add("admin", "deployResolver", root, "resolver:admin");
  add("admin", "setResolver", root, "root-resolver", [], false);
  for (const n of nodes.filter(isOrgLevel)) {
    add("admin", "deployRegistry", n, `reg:${n.name}`);
    if (n.parent) add("admin", "register", n, `entry:${n.name}`, [`reg:${n.parent}`]);
    add("admin", "setSubregistry", n, `sub:${n.name}`, n.parent ? [`entry:${n.name}`] : [], false);
    add("admin", "setParent", n, `parent:${n.name}`, [`reg:${n.name}`]);
    add("admin", "bundle", n, `bundle:${n.name}`, ["resolver:admin"]);
    if (n.parent) add("admin", "renew", n, `renew:${n.name}`, [`entry:${n.name}`], false);
  }
  const employees = nodes.filter((n) => n.kind === "employee");
  for (const e of employees) {
    add("admin", "register", e, `entry:${e.name}`, [`reg:${e.parent}`]);
    add("admin", "bundle", e, `bundle:${e.name}`, ["resolver:admin"]);
    add("admin", "renew", e, `renew:${e.name}`, [`entry:${e.name}`], false);
  }
  // An employee with no agents sends nothing, like a member who hasn't run ./relay login yet.
  for (const e of employees.filter((x) => nodes.some((n) => n.kind === "agent" && n.employee === x.name))) {
    const me = e.name;
    add(me, "deployResolver", e, `resolver:${me}`);
    add(me, "deployRegistry", e, `reg:${me}`);
    add(me, "setSubregistry", e, `sub:${me}`);
    add(me, "setParent", e, `parent:${me}`, [`reg:${me}`]);
    for (const a of nodes.filter((x) => x.kind === "agent" && x.employee === me)) {
      add(me, "deployRegistry", a, `reg:${a.name}`);
      add(me, "unregister", a, `clear:${a.name}`, [`reg:${me}`], false);
      add(me, "register", a, `entry:${a.name}`, [`reg:${me}`, `clear:${a.name}`]);
      add(me, "renew", a, `renew:${a.name}`, [`entry:${a.name}`], false);
      add(me, "setSubregistry", a, `sub:${a.name}`, [`entry:${a.name}`], false);
      add(me, "setParent", a, `parent:${a.name}`, [`reg:${a.name}`]);
      add(me, "bundle", a, `bundle:${a.name}`, [`resolver:${me}`]);
      for (const s of nodes.filter((x) => x.kind === "subagent" && x.agent === a.name)) {
        add(me, "unregister", s, `clear:${s.name}`, [`reg:${a.name}`], false);
        // After the agent exists (and any renewal of it): a subagent never outlives its agent.
        add(me, "register", s, `entry:${s.name}`, [`reg:${a.name}`, `entry:${a.name}`, `renew:${a.name}`, `clear:${s.name}`]);
        add(me, "renew", s, `renew:${s.name}`, [`entry:${s.name}`], false);
        add(me, "bundle", s, `bundle:${s.name}`, [`resolver:${me}`]);
      }
    }
  }
  return steps;
}

export type TxTotals = { txs: number; gas: number };

export type PlanSummary = {
  names: Record<SeedKind, number> & { total: number };
  rootRegistration: TxTotals;
  /** The admin's own steps (not counting the root registration and the top-ups). */
  adminSteps: TxTotals;
  /** One ETH transfer per employee that sends transactions (one with agents). */
  topUps: TxTotals;
  admin: TxTotals;
  employees: TxTotals;
  perEmployee: Map<string, TxTotals>;
  total: TxTotals;
};

const sum = (steps: { gas: number }[]): TxTotals => ({ txs: steps.length, gas: steps.reduce((a, s) => a + s.gas, 0) });

/** What a fresh run sends (nothing registered yet), per wallet. */
export function summarizePlan(spec: OrgSpec): PlanSummary {
  const nodes = flattenSpec(spec);
  const fresh = planSteps(spec).filter((s) => s.fresh);
  const names = { company: 0, department: 0, team: 0, employee: 0, agent: 0, subagent: 0, total: nodes.length };
  for (const n of nodes) names[n.kind]++;
  const employees = nodes.filter((n) => n.kind === "employee").map((n) => n.name);
  const adminSteps = sum(fresh.filter((s) => s.signer === "admin"));
  const perEmployee = new Map(employees.map((e) => [e, sum(fresh.filter((s) => s.signer === e))]));
  const senders = [...perEmployee.values()].filter((t) => t.txs > 0).length;
  const topUps = { txs: senders, gas: senders * GAS.transfer };
  const emp = [...perEmployee.values()].reduce((a, t) => ({ txs: a.txs + t.txs, gas: a.gas + t.gas }), { txs: 0, gas: 0 });
  const admin = { txs: ROOT_REGISTRATION.txs + adminSteps.txs + topUps.txs, gas: ROOT_REGISTRATION.gas + adminSteps.gas + topUps.gas };
  return {
    names,
    rootRegistration: { ...ROOT_REGISTRATION },
    adminSteps,
    topUps,
    admin,
    employees: emp,
    perEmployee,
    total: { txs: admin.txs + emp.txs, gas: admin.gas + emp.gas },
  };
}

/**
 * Wei an employee needs for `txs` transactions of `gas` in total: Sender pads each estimate
 * (×1.25 + 20k gas) and checks it at maxFeePerGas; 30% more on top for fee moves.
 */
export function fundingNeed(gas: number, txs: number, maxFeePerGas: bigint): bigint {
  const padded = (BigInt(gas) * 5n) / 4n + 20_000n * BigInt(txs);
  return (padded * maxFeePerGas * 13n) / 10n;
}

// --- Expiry ---------------------------------------------------------------------------------------

/** The expiry a renewal extends to: `days` from now, never past `cap` (the level above). */
export const renewTarget = (now: number, days: number, cap?: number | null) => Math.min(now + Math.round(days * DAY), cap ?? Infinity);

/**
 * A registered name is renewed once less than a quarter of its term is left (and the renewal
 * would gain more than a minute), so a re-run right after a finished run sends nothing.
 */
export function renewDue(expiry: number, now: number, days: number, cap?: number | null): boolean {
  return expiry - now < (days * DAY) / 4 && renewTarget(now, days, cap) > expiry + 60;
}

// --- Printing -------------------------------------------------------------------------------------

const KIND_TEXT: Record<SeedKind, string> = {
  company: "company · admin",
  department: "department · admin",
  team: "team · admin",
  employee: "employee · own wallet",
  agent: "agent · agent key, no roles",
  subagent: "subagent · subagent key, no roles",
};

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * The tree, two lines per name: the name with its kind and owner, then its bundle and term.
 * `owner` may add an address to a name's owner.
 */
export function renderTree(spec: OrgSpec, opts: { owner?: (n: SeedNode) => string | null; compact?: boolean } = {}): string[] {
  const nodes = flattenSpec(spec);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const lines: string[] = [];
  const walk = (n: SeedNode, prefix: string, last: boolean, top: boolean) => {
    const who = opts.owner?.(n);
    const head = `${KIND_TEXT[n.kind]}${who ? ` ${who}` : ""}`;
    lines.push(`${prefix}${top ? "" : last ? "└─ " : "├─ "}${n.name}  ${opts.compact ? n.kind : head}`);
    const below = top ? "" : `${prefix}${last ? "   " : "│  "}`;
    if (!opts.compact) lines.push(`${below}${n.children.length ? "│  " : "   "}${describeBundle(n.bundle)} · ${n.days} d`);
    n.children.forEach((c, i) => walk(byName.get(c)!, below, i === n.children.length - 1, false));
  };
  walk(nodes[0], "", true, true);
  return lines;
}

// --- demo-reset --------------------------------------------------------------------------------------

export type SweepTarget = {
  /** A team (or the launch squad) whose registry demo-reset lists. */
  parent: string;
  /** Labels to keep there; everything else registered under it is removed. */
  keep: Set<string>;
  /** Which script builds it (for the "no registry" hint). */
  source: "org-setup" | "org-seed";
  /** Skip quietly when it isn't set up (org-setup's tree next to a seeded company). */
  optional: boolean;
};

/**
 * Where demo-reset looks for names added during demos: org-setup's teams and launch squad
 * (keeping launch, its alias and mia) and, when org/<org>.json exists, every team of the spec
 * (keeping its seeded employees; their agents and subagents live in the employees' own
 * registries, which the sweep never touches). A developer added live under a team, and with it
 * everything under the developer, is removed.
 */
export function resetSweep(setup: { teams: { name: string }[]; launch: string; keep: Map<string, Set<string>> }, spec: OrgSpec | null): SweepTarget[] {
  const targets = new Map<string, SweepTarget>();
  for (const parent of [...setup.teams.map((t) => t.name), setup.launch]) {
    targets.set(parent, { parent, keep: new Set(setup.keep.get(parent) ?? []), source: "org-setup", optional: !!spec });
  }
  for (const t of spec ? flattenSpec(spec).filter((n) => n.kind === "team") : []) {
    const seeded = new Set(t.children.map((c) => c.split(".")[0]));
    const existing = targets.get(t.name);
    if (existing) {
      for (const l of seeded) existing.keep.add(l);
      existing.optional = false;
    } else {
      targets.set(t.name, { parent: t.name, keep: seeded, source: "org-seed", optional: false });
    }
  }
  return [...targets.values()];
}
