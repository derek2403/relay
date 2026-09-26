// npm run org:seed: buys and builds a whole company on ENSv2 (Sepolia) from org/<label>.json.
//
//   <org>.eth → departments dev, biz, mkt → 1-2 teams each → 1-2 employees per team
//             → 0-2 agents per employee → 1-3 subagents per agent
//
// The spec (org/sodalabs.json by default) is generated once from a seed and committed; edit it
// freely. Who owns what, and who sends which transaction, is what the real flows do:
//   - The admin (ADMIN_PRIVATE_KEY) registers <org>.eth (MockUSDC, commit, wait, register, as
//     org-setup does) and owns the company, departments and teams: each gets its own UserRegistry
//     (Verifiable Factory), setSubregistry, setParent, and its limits on the admin's resolver.
//   - The admin adds each employee like the portal's Add a member: owner = the employee's own
//     wallet, ROLE_SET_SUBREGISTRY, limits on the admin's resolver. Then it sends them just
//     enough Sepolia ETH for their own transactions.
//   - Each employee's wallet does what ./relay login and ./relay subagent create do: deploys its
//     resolver and registry, attaches the registry under its name and points it back, registers
//     its agents (owner = agent key, no roles, the agent's own registry attached) with limits and
//     addr on its resolver, then registers the agents' subagents (owner = subagent key, no roles).
// Keys: employees keccak256(adminKey ‖ "<org>:employee:<name>"), agents from their employee's
// key, subagents from their agent's key (scripts/lib/org-seed.ts). Nothing is written to disk
// unless --export-keys is given.
//
// Safe to re-run and to resume after a crash: it reads the chain first and only sends what is
// missing (a finished tree sends 0 transactions). --plan prints everything without sending.
// Env: ADMIN_PRIVATE_KEY, ORG_LABEL (else the spec / RELAY_ROOT_NAME), RELAY_RPC_URL or
// NEXT_PUBLIC_SEPOLIA_RPC_URL (else a public RPC). .env.local is read like org-setup reads it.
// Docs: docs/org-seed.md

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { type Address, type Hex, formatEther, isAddressEqual, isHex, parseEther, zeroAddress } from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

import { formatError } from "../lib/ens/errors";
import { tryNormalize } from "../lib/ens/names";
import { RegistryRoles } from "../lib/ens/roles";
import { describeBundle } from "../lib/relay/bundle";
import {
  type Chain,
  DEFAULT_RPC_URL,
  ETH_REGISTRY,
  REPO_ROOT,
  Sender,
  type Step,
  UserError,
  bundleWrites,
  chainNow,
  connect,
  envRpc,
  hasCode,
  hasRootRoles,
  loadEnvFiles,
  parentIs,
  readEntry,
  readParent,
  registryAddress,
  resolverAddress,
  runSteps,
  shortError,
  tx,
} from "./lib/ensv2";
import { registerRoot } from "./lib/org-root";
import {
  AGENT_DAYS,
  DAY,
  DEFAULT_ORG,
  GAS,
  type OrgSpec,
  type PlannedStep,
  type SeedKey,
  type SeedNode,
  flattenSpec,
  fundingNeed,
  generateSpec,
  isOrgLevel,
  listSpecs,
  planSteps,
  readSpec,
  renderTree,
  renewDue,
  renewTarget,
  seedKeys,
  shortAddress,
  specPath,
  summarizePlan,
  writeSpec,
} from "./lib/org-seed";

const say = (line = "") => console.log(line);
const check = (line: string) => say(`  ✓ ${line}`);
const rel = (file: string) => path.relative(process.cwd(), file) || file;
const fmtEth = (wei: bigint) => {
  const n = Number(formatEther(wei));
  return n === 0 ? "0" : n < 0.0001 ? n.toExponential(2) : n.toFixed(4);
};
const fmtGas = (gas: number) => `${(gas / 1e6).toFixed(2)}M gas`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Rate-limited RPC responses (429) seen, for the hint at the end. */
let rateLimited = 0;
/** True once the run started sending, so an error says how to resume. */
let sending = false;

const HELP = `npm run org:seed [-- options]
Buys <org>.eth on ENSv2 Sepolia and builds the whole company in org/<label>.json:
departments, teams, employees (own wallets), their agents and subagents.

  --plan, --dry-run      Print the tree (every name, its owner and limits) and what a fresh run
                         sends, with a gas estimate. Sends nothing; ADMIN_PRIVATE_KEY is optional.
  --label <label>        The company (default: ORG_LABEL, else RELAY_ROOT_NAME when org/<it>.json
                         exists, else the only spec in org/, else "${DEFAULT_ORG}")
  --spec <file>          Use this spec file instead of org/<label>.json
  --seed <text>          Seed for a new spec (default: the label)
  --regenerate           Replace the spec with a new one (a new random seed unless --seed is given)
  --agent-days <n>       Term of agents and subagents in a new spec (default ${AGENT_DAYS})
  --fund-eth <eth>       Top each employee up to this much ETH instead of the computed amount
  --parallel <n>         Employees sending at the same time (default 3)
  --export-keys <file>   Write the derived employee, agent and subagent keys to <file> (mode 600;
                         the path must be gitignored, like org/<label>.keys.json, or outside the repo)
  --gwei <n>             Gas price for --plan's ETH estimate (default 2)
  --verbose              Also list the steps that were already done

Env: ADMIN_PRIVATE_KEY (the wallet that owns the company), ORG_LABEL, RELAY_RPC_URL or
NEXT_PUBLIC_SEPOLIA_RPC_URL (read from .env.local too). Docs: docs/org-seed.md`;

type Opts = {
  label?: string;
  spec?: string;
  seed?: string;
  regenerate?: boolean;
  plan?: boolean;
  "dry-run"?: boolean;
  "agent-days"?: string;
  "fund-eth"?: string;
  parallel?: string;
  "export-keys"?: string;
  gwei?: string;
  verbose?: boolean;
  help?: boolean;
};

function parseOpts(): Opts {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        label: { type: "string" },
        spec: { type: "string" },
        seed: { type: "string" },
        regenerate: { type: "boolean" },
        plan: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "agent-days": { type: "string" },
        "fund-eth": { type: "string" },
        parallel: { type: "string" },
        "export-keys": { type: "string" },
        gwei: { type: "string" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    }).values as Opts;
  } catch (err) {
    throw new UserError(`${(err as Error).message.replace(/\.+$/, "")}. See npm run org:seed -- --help`);
  }
}

function positive(raw: string | undefined, flag: string, fallback: number, integer = false): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new UserError(`${flag} must be a positive ${integer ? "whole " : ""}number (got "${raw}").`);
  return n;
}

// --- The spec -----------------------------------------------------------------------------------------

function labelFrom(raw: string, from: string): string {
  const org = tryNormalize(raw.trim().replace(/\.eth$/, ""));
  if (!org || org.includes(".")) throw new UserError(`${from} "${raw}" must be a single label, like "${DEFAULT_ORG}".`);
  return org;
}

/** --label, ORG_LABEL, RELAY_ROOT_NAME when it has a spec, the only spec in org/, else the default. */
function orgLabel(opts: Opts): string {
  if (opts.label) return labelFrom(opts.label, "--label");
  if (process.env.ORG_LABEL?.trim()) return labelFrom(process.env.ORG_LABEL, "ORG_LABEL");
  const specs = listSpecs();
  const rootName = process.env.RELAY_ROOT_NAME?.trim().replace(/\.eth$/, "");
  if (rootName && specs.includes(rootName)) return rootName;
  if (specs.length === 1) return specs[0];
  return DEFAULT_ORG;
}

function loadOrMakeSpec(opts: Opts): { spec: OrgSpec; file: string } {
  let file = opts.spec ? path.resolve(opts.spec) : null;
  let existing = file ? readSpec(file) : null;
  const org = existing && !opts.label && !process.env.ORG_LABEL?.trim() ? existing.label : orgLabel(opts);
  file ??= specPath(org);
  existing ??= readSpec(file);
  if (existing && existing.label !== org && !opts.regenerate) {
    throw new UserError(`${rel(file)} is for ${existing.label}.eth, not ${org}.eth. Pass --label ${existing.label}, or --regenerate to replace it.`);
  }
  if (existing && !opts.regenerate) {
    if (opts.seed && opts.seed !== existing.seed) {
      throw new UserError(`${rel(file)} was made from seed "${existing.seed}". Pass --regenerate --seed ${opts.seed} to replace it.`);
    }
    if (opts["agent-days"]) say(`  ! --agent-days only applies to a new spec; edit "days" in ${rel(file)} (or pass --regenerate)`);
    return { spec: existing, file };
  }
  // A reroll picks a new seed; the first spec uses the label, so it is the same everywhere.
  const seed = opts.seed ?? (opts.regenerate ? `${org}-${randomBytes(3).toString("hex")}` : org);
  const spec = generateSpec(org, seed, { agentDays: positive(opts["agent-days"], "--agent-days", AGENT_DAYS) });
  writeSpec(file, spec);
  say(`${existing ? "Replaced" : "Wrote"} ${rel(file)} for ${org}.eth (seed "${seed}"). Commit it: demo:reset keeps what it lists.`);
  return { spec, file };
}

function adminKey(required: boolean): Hex | null {
  const key = process.env.ADMIN_PRIVATE_KEY?.trim();
  if (!key) {
    if (required) throw new UserError("Set ADMIN_PRIVATE_KEY=0x… (the wallet that will own the company, its departments and teams). --plan works without it.");
    return null;
  }
  const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!isHex(privateKey) || privateKey.length !== 66) throw new UserError("ADMIN_PRIVATE_KEY must be a 32-byte hex private key.");
  return privateKey;
}

// --- Keys on disk (only when asked) --------------------------------------------------------------------

function exportKeys(file: string, spec: OrgSpec, admin: Address, keys: Map<string, SeedKey>) {
  const abs = path.resolve(file);
  const inside = path.relative(REPO_ROOT, abs);
  if (!inside.startsWith("..") && !path.isAbsolute(inside)) {
    let ignored = false;
    try {
      execFileSync("git", ["check-ignore", "-q", abs], { cwd: REPO_ROOT, stdio: "ignore" });
      ignored = true;
    } catch {}
    if (!ignored) {
      throw new UserError(`${rel(abs)} is inside the repo and not gitignored. Use org/${spec.label}.keys.json (gitignored) or a path outside the repo.`);
    }
  }
  const body = {
    note: `Keys npm run org:seed derived from ADMIN_PRIVATE_KEY for ${spec.label}.eth. Anyone with this file can act as these names. Keep it private.`,
    root: `${spec.label}.eth`,
    admin,
    keys: [...keys.values()].map((k) => ({ name: k.name, kind: k.kind, address: k.address, privateKey: k.privateKey })),
  };
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, abs);
  fs.chmodSync(abs, 0o600);
  say(`Wrote ${keys.size} keys to ${rel(abs)} (mode 600).`);
}

// --- --plan ---------------------------------------------------------------------------------------------

function namesLine(spec: OrgSpec): string {
  const { names } = summarizePlan(spec);
  return `${plural(names.department, "department")} · ${plural(names.team, "team")} · ${plural(names.employee, "employee")} · ${plural(names.agent, "agent")} · ${plural(names.subagent, "subagent")} = ${names.total} names`;
}

function ownerText(admin: Address | null, keys: Map<string, SeedKey> | null) {
  return (n: SeedNode) => {
    const address = isOrgLevel(n) ? admin : (keys?.get(n.name)?.address ?? null);
    return address ? shortAddress(address) : null;
  };
}

function printPlan(spec: OrgSpec, file: string, admin: Address | null, keys: Map<string, SeedKey> | null, gwei: number) {
  const s = summarizePlan(spec);
  const root = `${spec.label}.eth`;
  const price = BigInt(Math.round(gwei * 1e9));
  const eth = (gas: number) => fmtEth(BigInt(gas) * price);
  say(`Plan for ${root} from ${rel(file)} (seed "${spec.seed}"). Nothing is sent.`);
  say(`  ${namesLine(spec)}`);
  if (!admin) say("  (set ADMIN_PRIVATE_KEY to see the addresses; the keys are derived from it)");
  say("");
  for (const line of renderTree(spec, { owner: ownerText(admin, keys) })) say(`  ${line}`);

  const levels = s.names.company + s.names.department + s.names.team;
  say(`\nTransactions for a fresh run (a re-run sends only what is missing on chain)`);
  say(`  admin        ${String(s.admin.txs).padStart(4)} txs  ≈ ${fmtGas(s.admin.gas)}`);
  say(`                 register ${root}: ${s.rootRegistration.txs} (mint MockUSDC, approve, commit, register)`);
  say(`                 its resolver and ${levels} levels (registry, entry, setParent, limits): ${s.adminSteps.txs - 2 * s.names.employee}`);
  say(`                 ${s.names.employee} employees' names and limits (Add a member): ${2 * s.names.employee}`);
  say(`                 gas top-ups for the employees: ${s.topUps.txs}`);
  say(`  employees    ${String(s.employees.txs).padStart(4)} txs  ≈ ${fmtGas(s.employees.gas)}  (each from its own wallet)`);
  const nodes = flattenSpec(spec);
  for (const [name, t] of s.perEmployee) {
    const agents = nodes.filter((n) => n.kind === "agent" && n.employee === name).length;
    const subs = nodes.filter((n) => n.kind === "subagent" && n.employee === name).length;
    say(`                 ${name}: ${t.txs ? `${t.txs} txs ≈ ${fmtGas(t.gas)} (${plural(agents, "agent")}, ${plural(subs, "subagent")})` : "nothing (no agents, like a member who hasn't logged in yet)"}`);
  }
  say(`  total        ${String(s.total.txs).padStart(4)} txs  ≈ ${fmtGas(s.total.gas)}  ≈ ${eth(s.total.gas)} ETH at ${gwei} gwei`);
  const topUps = [...s.perEmployee.values()].reduce((a, t) => a + fundingNeed(t.gas, t.txs, price), 0n);
  say(`  The admin wallet needs about ${fmtEth(BigInt(s.admin.gas) * price + topUps)} Sepolia ETH at ${gwei} gwei:`);
  say(`  ${eth(s.admin.gas)} for its own gas plus ${fmtEth(topUps)} of top-ups (padded for fee moves; employees keep what they don't use).`);
  say(`  Gas per call is an estimate (scripts/lib/org-seed.ts GAS); the run estimates every transaction before sending it.`);
}

// --- The run ---------------------------------------------------------------------------------------------

/** Runs `fn` on each item, `size` at a time; after the first failure no new item starts, and it is rethrown. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  if (failed) throw failed;
}

/** One admin transaction batch at a time (employees may ask for a second top-up concurrently). */
function serial() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };
}

async function rpc<T>(chain: Chain, method: string, params: unknown[]): Promise<T> {
  return (await chain.pub.request({ method, params } as never)) as T;
}

async function seed(spec: OrgSpec, file: string, privateKey: Hex, keys: Map<string, SeedKey>, opts: Opts) {
  const org = spec.label;
  const root = `${org}.eth`;
  const admin = privateKeyToAccount(privateKey);
  const rpcUrl = envRpc() || DEFAULT_RPC_URL;
  const verbose = !!opts.verbose;
  const parallel = positive(opts.parallel, "--parallel", 3, true);
  const fundEth = opts["fund-eth"] ? parseEther(String(positive(opts["fund-eth"], "--fund-eth", 0))) : null;
  const nodes = flattenSpec(spec);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const employees = nodes.filter((n) => n.kind === "employee");
  const planned = planSteps(spec);
  const summary = summarizePlan(spec);

  say(`Seeding ${root} on ENSv2 (Sepolia) from ${rel(file)} · admin ${admin.address} · RPC ${rpcUrl}`);
  say(`  ${namesLine(spec)}; a fresh run sends ${summary.total.txs} transactions (npm run org:seed -- --plan shows them)`);
  if (rpcUrl === DEFAULT_RPC_URL) say("  ! the public RPC rate-limits bursts; set RELAY_RPC_URL (or NEXT_PUBLIC_SEPOLIA_RPC_URL) to your own Sepolia RPC");
  const chain = await connect(rpcUrl, {
    retryCount: 6,
    retryDelay: 1000,
    onFetchResponse: (res) => {
      if (res.status === 429) rateLimited++;
    },
  });
  const { pub } = chain;

  const sent = { admin: 0, employees: 0 };
  const adminSender = new Sender(chain, admin, (line) => {
    sent.admin++;
    check(line);
  });
  const account = (name: string): PrivateKeyAccount => privateKeyToAccount(keys.get(name)!.privateKey);
  const keyAddr = (name: string): Address => keys.get(name)!.address;

  if (chain.local && (await hasCode(pub, admin.address))) {
    // Anvil's dev accounts carry EIP-7702 code on Sepolia, which rejects the ERC-1155 mint callback.
    await rpc(chain, "anvil_setCode", [admin.address, "0x"]);
    check("cleared the admin's EIP-7702 code on this local fork (names are ERC-1155 tokens)");
  }
  const wallets = [admin.address, ...employees.map((e) => keyAddr(e.name))];
  const balances = async () => Promise.all(wallets.map((address) => pub.getBalance({ address })));
  const before = await balances();
  say(`  Admin balance: ${fmtEth(before[0])} ETH`);
  if (before[0] === 0n) throw new UserError(`The admin ${admin.address} has no Sepolia ETH. Fund it first (npm run org:seed -- --plan estimates how much).`);

  // --- Addresses (all known before anything is deployed: CREATE2) ---
  const adminResolver = await resolverAddress(pub, admin.address);
  const resolvers = new Map<string, Address>([["admin", adminResolver]]);
  /** Each name's own subname registry. */
  const registry = new Map<string, Address>();
  // A level that already has a subname registry the admin controls (e.g. made in the portal) keeps it, like org-setup.
  for (const n of nodes.filter(isOrgLevel)) {
    const parentRegistry = n.parent ? registry.get(n.parent)! : ETH_REGISTRY;
    const existing = (await readEntry(pub, parentRegistry, n.label)).subregistry;
    if (existing && !(await hasRootRoles(pub, existing, RegistryRoles.ROLE_REGISTRAR, admin.address))) {
      throw new UserError(`${n.name} already has a subname registry (${existing}) that the admin doesn't control. Fix it in the portal, then re-run.`);
    }
    registry.set(n.name, existing ?? (await registryAddress(pub, admin.address, n.name)));
  }

  const holderOf = (n: SeedNode): Address => (n.parent ? registry.get(n.parent)! : ETH_REGISTRY);
  const entryOf = (n: SeedNode) => readEntry(pub, holderOf(n), n.label);
  const ownerOf = (n: SeedNode): Address => (isOrgLevel(n) ? admin.address : keyAddr(n.name));
  /** The resolver that serves a name and holds its limits: the level above's owner's. */
  const servingResolver = (n: SeedNode) => (n.kind === "agent" || n.kind === "subagent" ? resolvers.get(n.employee!)! : adminResolver);
  /** A name never outlives the level it depends on (./relay does the same for agents and subagents). */
  const capOf = async (n: SeedNode): Promise<number | null> =>
    n.kind === "agent" ? (await entryOf(byName.get(n.employee!)!)).expiry : n.kind === "subagent" ? (await entryOf(byName.get(n.agent!)!)).expiry : null;
  const owned = async (n: SeedNode) => {
    const e = await entryOf(n);
    return e.registered && !!e.owner && isAddressEqual(e.owner, ownerOf(n));
  };
  /** The admin's names and the employees' names must not belong to anyone else: stop, don't take them over. */
  const assertNotTaken = async (n: SeedNode) => {
    if (n.kind === "agent" || n.kind === "subagent") return;
    const e = await entryOf(n);
    if (e.registered && e.owner && !isAddressEqual(e.owner, ownerOf(n))) {
      throw new UserError(`${n.name} is registered to ${e.owner}, not ${ownerOf(n)}. Remove it in the portal (or pick other labels in ${rel(file)}), then re-run.`);
    }
  };

  // --- The company name ---
  say("\nCompany name");
  const created = new Set<string>();
  const rootEntry = await readEntry(pub, ETH_REGISTRY, org);
  if (rootEntry.registered && rootEntry.owner && !isAddressEqual(rootEntry.owner, admin.address)) {
    throw new UserError(`${root} belongs to ${rootEntry.owner}, not the admin ${admin.address}. Pick another label (--label or ORG_LABEL; a new spec gets generated) or run with that wallet's key.`);
  }
  // Nothing is sent before every admin-owned name is known to be free or already the admin's.
  await Promise.all(nodes.filter((n) => n.parent && (isOrgLevel(n) || n.kind === "employee")).map(assertNotTaken));
  sending = true;
  if (rootEntry.registered) {
    const days = Math.floor((rootEntry.expiry - (await chainNow(pub))) / DAY);
    check(`${root} is the admin's (expires ${new Date(rootEntry.expiry * 1000).toISOString().slice(0, 10)})`);
    if (days < 30) say(`  ! ${root} expires in ${days} days; renew it (the relay refuses everything once it expires)`);
  } else {
    await registerRoot(chain, adminSender, privateKey, org, registry.get(root)!, adminResolver, { check, say }, spec.root.days);
    created.add(root);
  }

  const now0 = await chainNow(pub);
  const stepOf = (p: PlannedStep): Step => {
    const n = byName.get(p.name)!;
    const signer = p.signer === "admin" ? admin.address : keyAddr(p.signer);
    const own = () => registry.get(n.name)!;
    const agentKey = n.kind === "agent" || n.kind === "subagent" ? keyAddr(n.name) : undefined;
    const base = { id: p.id, deps: p.deps };
    switch (p.op) {
      case "deployResolver":
        return {
          ...base,
          title: `deployed ${p.signer === "admin" ? "the admin's" : `${p.signer}'s`} resolver ${resolvers.get(p.signer)}`,
          done: () => hasCode(pub, resolvers.get(p.signer)!),
          tx: () => tx.deployResolver(signer),
        };
      case "deployRegistry":
        return { ...base, title: `deployed the registry for ${n.name}`, done: () => hasCode(pub, own()), tx: () => tx.deployRegistry(signer, n.name) };
      case "setResolver":
        return {
          ...base,
          title: `use the admin's resolver for ${n.name}`,
          done: async () => {
            const e = await entryOf(n);
            return !!e.resolver && isAddressEqual(e.resolver, adminResolver);
          },
          tx: () => tx.setResolver(ETH_REGISTRY, n.label, adminResolver),
        };
      case "register": {
        const title =
          n.kind === "employee"
            ? `added ${n.name} for ${shortAddress(ownerOf(n))} (ROLE_SET_SUBREGISTRY, like Add a member)`
            : n.kind === "agent"
              ? `created ${n.name} (agent key ${shortAddress(ownerOf(n))}, no roles, its registry attached)`
              : n.kind === "subagent"
                ? `created ${n.name} (subagent key ${shortAddress(ownerOf(n))}, no roles)`
                : `added ${n.name} with its registry attached`;
        return {
          ...base,
          title,
          done: () => owned(n),
          tx: async () => {
            await assertNotTaken(n);
            created.add(n.name);
            if (isOrgLevel(n)) return tx.register(holderOf(n), n.label, admin.address, own(), adminResolver, RegistryRoles.ROLE_SET_SUBREGISTRY, renewTarget(now0, n.days));
            // Members get ROLE_SET_SUBREGISTRY on their own name, so they can hang their agents under it (AddMemberDialog).
            if (n.kind === "employee") return tx.register(holderOf(n), n.label, ownerOf(n), zeroAddress, adminResolver, RegistryRoles.ROLE_SET_SUBREGISTRY, renewTarget(now0, n.days));
            const now = await chainNow(pub);
            const cap = await capOf(n);
            if (!cap || cap <= now) throw new UserError(`${n.parent} isn't registered (or has expired), so ${n.name} can't be added under it.`);
            const expiry = renewTarget(now, n.days, cap);
            // Agents and subagents: owner = their key with no roles (it signs tokens, changes nothing). An agent's registry is attached here.
            return tx.register(holderOf(n), n.label, ownerOf(n), n.kind === "agent" ? own() : zeroAddress, servingResolver(n), 0n, expiry);
          },
        };
      }
      case "setSubregistry":
        return {
          ...base,
          title: `attached ${n.name}'s registry (setSubregistry)`,
          done: async () => {
            const e = await entryOf(n);
            return !!e.subregistry && isAddressEqual(e.subregistry, own());
          },
          tx: () => tx.setSubregistry(holderOf(n), n.label, own()),
        };
      case "setParent":
        return {
          ...base,
          title: `pointed ${n.name}'s registry back at ${n.parent ?? "eth"} (setParent)`,
          done: async () => parentIs(await readParent(pub, own()), holderOf(n), n.label),
          tx: () => tx.setParent(own(), holderOf(n), n.label),
        };
      case "bundle":
        return {
          ...base,
          title: `limits for ${n.name}: ${describeBundle(n.bundle)}${agentKey ? " (+ addr)" : ""}`,
          done: async () => (await bundleWrites(pub, servingResolver(n), n.name, n.bundle, agentKey)).length === 0,
          tx: async () => {
            const calls = await bundleWrites(pub, servingResolver(n), n.name, n.bundle, agentKey);
            return calls.length ? tx.resolverMulticall(servingResolver(n), calls) : null;
          },
        };
      case "renew":
        return {
          ...base,
          title: `renewed ${n.name} (${n.days} d)`,
          done: async () => {
            const e = await entryOf(n);
            return !e.registered || !renewDue(e.expiry, await chainNow(pub), n.days, await capOf(n));
          },
          tx: async () => tx.renew(holderOf(n), n.label, renewTarget(await chainNow(pub), n.days, await capOf(n))),
        };
      case "unregister":
        return {
          ...base,
          title: `removed ${n.name}, held by a key that isn't its seeded one`,
          done: async () => {
            const e = await entryOf(n);
            return !e.registered || (!!e.owner && isAddressEqual(e.owner, ownerOf(n)));
          },
          tx: () => tx.unregister(holderOf(n), n.label),
        };
    }
  };

  /**
   * Runs one wallet's steps. Finished steps are skipped (listed with --verbose, else counted);
   * repair-only steps (renew, clear, a setSubregistry that register already did) aren't counted.
   */
  const runPhase = async (sender: Sender, plannedSteps: PlannedStep[], who: string | null) => {
    const steps = plannedSteps.map(stepOf);
    const quiet = new Set(steps.filter((_, i) => !plannedSteps[i].fresh).map((s) => s.title));
    const skipped: string[] = [];
    await runSteps(sender, steps, {
      skipped: (t) => {
        if (verbose) check(`${t} (already done)`);
        else if (!quiet.has(t)) skipped.push(t);
      },
    });
    if (skipped.length) say(`  - ${who ? `${who}: ` : ""}${plural(skipped.length, "step")} already done (--verbose lists them)`);
  };

  // --- 1. The admin: company, departments, teams, and the employees' names ---
  say("\nCompany, departments, teams and employees (admin)");
  await runPhase(adminSender, planned.filter((s) => s.signer === "admin"), null);

  // --- Employees' addresses: resolver, registry (kept if already attached and theirs, like ./relay login), agents' registries ---
  for (const e of employees) {
    const me = keyAddr(e.name);
    const entry = await entryOf(e);
    if (entry.subregistry && !(await hasRootRoles(pub, entry.subregistry, RegistryRoles.ROLE_REGISTRAR, me))) {
      throw new UserError(`${e.name} already has a subname registry (${entry.subregistry}) that its wallet doesn't control.`);
    }
    resolvers.set(e.name, await resolverAddress(pub, me));
    registry.set(e.name, entry.subregistry ?? (await registryAddress(pub, me, e.name)));
    for (const a of nodes.filter((n) => n.kind === "agent" && n.employee === e.name)) registry.set(a.name, await registryAddress(pub, me, a.name));
  }
  const employeeSteps = new Map(employees.map((e) => [e.name, planned.filter((s) => s.signer === e.name)]));

  // --- 2. Gas: the admin tops up each employee that still has transactions to send ---
  say("\nGas for the employees (from the admin)");
  const withAdmin = serial();
  let funded = 0n;
  /**
   * What `e` still has to send and the top-up that covers it (null: its balance is enough, or it
   * has nothing to send). Only unfinished steps count, so a re-run never tops up a finished employee.
   */
  const topUpFor = async (e: SeedNode, factor = 1n) => {
    const plannedSteps = employeeSteps.get(e.name)!;
    const done = await Promise.all(plannedSteps.map((p) => stepOf(p).done().catch(() => false)));
    const pending = plannedSteps.filter((_, i) => !done[i]);
    if (!pending.length) return { pending: 0, amount: null };
    const computed = fundingNeed(pending.reduce((a, p) => a + p.gas, 0), pending.length, (await pub.estimateFeesPerGas()).maxFeePerGas);
    const need = (fundEth ?? computed) * factor;
    const balance = await pub.getBalance({ address: keyAddr(e.name) });
    return { pending: pending.length, amount: balance < need ? need - balance : null };
  };
  const topUpItem = (e: SeedNode, amount: bigint, pending: number) => ({
    title: `sent ${fmtEth(amount)} ETH to ${e.name} (${shortAddress(keyAddr(e.name))}) for up to ${plural(pending, "transaction")}`,
    call: { to: keyAddr(e.name), data: "0x" as Hex, value: amount },
  });
  const needs = new Map<string, { pending: number; amount: bigint | null }>();
  await pool(employees, Math.max(parallel, 4), async (e) => {
    needs.set(e.name, await topUpFor(e));
  });
  const transfers = employees.flatMap((e) => {
    const n = needs.get(e.name)!;
    return n.amount ? [topUpItem(e, n.amount, n.pending)] : [];
  });
  await withAdmin(() => adminSender.sendAll(transfers));
  funded += transfers.reduce((a, t) => a + t.call.value, 0n);
  const idle = [...needs.values()].filter((x) => !x.pending).length;
  const enough = [...needs.values()].filter((x) => x.pending && !x.amount).length;
  if (idle || enough) say(`  - ${[idle ? `${plural(idle, "employee")} with nothing left to send` : "", enough ? `${plural(enough, "employee")} with enough ETH already` : ""].filter(Boolean).join(", ")}`);

  // --- 3. Each employee's own wallet: resolver, registry, agents, subagents ---
  say(`\nAgents and subagents (each employee's wallet, like ./relay login and ./relay subagent create)`);
  await pool(employees, parallel, async (e) => {
    const sender = new Sender(chain, account(e.name), (line) => {
      sent.employees++;
      check(line);
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await runPhase(sender, employeeSteps.get(e.name)!, e.name);
        return;
      } catch (err) {
        // Gas estimates are padded, but fees can jump mid-run: one more top-up, then resume.
        if (attempt > 0 || !(err instanceof UserError) || !/Not enough Sepolia ETH/.test(err.message)) throw err;
        await withAdmin(async () => {
          const again = await topUpFor(e, 2n);
          const amount = again.amount ?? fundingNeed(GAS.deployResolver, 1, (await pub.estimateFeesPerGas()).maxFeePerGas);
          await adminSender.sendAll([topUpItem(e, amount, again.pending)]);
          funded += amount;
        });
      }
    }
  });

  // --- Summary ---
  const after = await balances();
  const spent = before.reduce((a, b) => a + b, 0n) - after.reduce((a, b) => a + b, 0n);
  const total = sent.admin + sent.employees;
  say(`\n${total ? `Done: ${total} transactions (admin ${sent.admin}, employees ${sent.employees}).` : "Everything was already set up: 0 transactions."}`);
  say(`  names: ${created.size} created, ${nodes.length - created.size} already there (${nodes.length} in the spec)`);
  say(`  ETH: ${fmtEth(spent)} spent on gas${funded ? `; ${fmtEth(funded)} of it sent to employees first (they keep what's left)` : ""}; the admin has ${fmtEth(after[0])} left`);
  if (rateLimited) say(`  ! the RPC answered 429 (rate limited) ${plural(rateLimited, "time")}; a private Sepolia RPC in RELAY_RPC_URL makes this faster`);
  say("");
  for (const line of renderTree(spec, { compact: true })) say(`  ${line}`);
  say("\nPut these in .env.local (then restart npm run dev):");
  say(`RELAY_ROOT_NAME=${root}`);
  say(`RELAY_ROOT_OWNER=${admin.address}`);
  const devTeam = nodes.find((n) => n.kind === "team" && n.parent === `dev.${root}`);
  say(`\nPer demo: in the portal select a team (e.g. ${devTeam?.name ?? `a team under dev.${root}`}) → Add a member → ./relay init / login / codex → Remove → npm run demo:reset. It keeps everything in ${rel(file)}.`);
}

async function main() {
  const opts = parseOpts();
  if (opts.help) {
    say(HELP);
    return;
  }
  loadEnvFiles(["RELAY_RPC_URL", "NEXT_PUBLIC_SEPOLIA_RPC_URL", "RELAY_ROOT_NAME"]);
  const planOnly = !!(opts.plan || opts["dry-run"]);
  const gwei = positive(opts.gwei, "--gwei", 2);
  const { spec, file } = loadOrMakeSpec(opts);
  const privateKey = adminKey(!planOnly);
  const admin = privateKey ? privateKeyToAccount(privateKey).address : null;
  const keys = privateKey ? seedKeys(privateKey, spec) : null;
  if (opts["export-keys"]) {
    if (!privateKey || !keys || !admin) throw new UserError("--export-keys needs ADMIN_PRIVATE_KEY (the keys are derived from it).");
    exportKeys(opts["export-keys"], spec, admin, keys);
  }
  if (planOnly) {
    printPlan(spec, file, admin, keys, gwei);
    return;
  }
  await seed(spec, file, privateKey!, keys!, opts);
}

main().catch((err) => {
  const text = err instanceof UserError ? err.message : formatError(err) || shortError(err);
  console.error(`\nerror: ${text}`);
  if (rateLimited || /\b429\b|rate.?limit|too many requests/i.test(`${text} ${(err as Error)?.message ?? ""}`)) {
    console.error("The RPC is rate limiting. Set RELAY_RPC_URL to your own Sepolia RPC (Alchemy, Infura, QuickNode, …) in .env.local and run npm run org:seed again: it resumes where it stopped.");
  } else if (sending) {
    console.error("Run npm run org:seed again to resume: every finished step is skipped.");
  }
  if (process.env.DEBUG && !(err instanceof UserError)) console.error(err);
  process.exitCode = 1;
});
