// npm run org:setup: builds the demo company on ENSv2 (Sepolia) with one admin wallet.
//
//   <org>.eth -> 3 departments -> 6 teams, plus the launch squad (launch.dev.eng.<org>.eth,
//   also reachable as the non-canonical alias launch.growth.marketing.<org>.eth) and its member mia.
//
// Every level the admin owns gets its own UserRegistry (Verifiable Factory), attached under its
// name (setSubregistry) and pointed back at its parent (setParent), and its bundle lives on the
// admin's one PermissionedResolver (records are keyed by the full name's namehash).
//
// Env: ADMIN_PRIVATE_KEY, ORG_LABEL (e.g. "acme"; else RELAY_ROOT_NAME from .env.local), and the RPC
// (RELAY_RPC_URL, NEXT_PUBLIC_SEPOLIA_RPC_URL, else a public one). Safe to re-run: it reads the chain
// first and skips every finished step.

import { type Address, type Hex, formatEther, isAddressEqual, isHex, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { formatError } from "../lib/ens/errors";
import { tryNormalize } from "../lib/ens/names";
import { RegistryRoles } from "../lib/ens/roles";
import { describeBundle } from "../lib/relay/bundle";
import {
  type Chain,
  DEFAULT_RPC_URL,
  ETH_REGISTRY,
  type OrgLevel,
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
  LEGACY_MIA,
  miaAccount,
  orgPlan,
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

const DAY = 86_400;
const say = (line = "") => console.log(line);
const check = (line: string) => say(`  ✓ ${line}`);

function settings() {
  loadEnvFiles(["RELAY_RPC_URL", "NEXT_PUBLIC_SEPOLIA_RPC_URL", "RELAY_ROOT_NAME"]);
  const key = process.env.ADMIN_PRIVATE_KEY?.trim();
  if (!key) throw new UserError("Set ADMIN_PRIVATE_KEY=0x… (the wallet that will own the company and every level down to the teams).");
  const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!isHex(privateKey) || privateKey.length !== 66) throw new UserError("ADMIN_PRIVATE_KEY must be a 32-byte hex private key.");
  const raw = process.env.ORG_LABEL?.trim() || process.env.RELAY_ROOT_NAME?.trim().replace(/\.eth$/, "") || "";
  if (!raw) throw new UserError('Set ORG_LABEL, e.g. ORG_LABEL=acme for acme.eth.');
  const org = tryNormalize(raw.replace(/\.eth$/, ""));
  if (!org || org.includes(".")) throw new UserError(`ORG_LABEL "${raw}" must be a single label, like "acme".`);
  return { privateKey, org, rpc: envRpc() || DEFAULT_RPC_URL };
}

async function rpc<T>(chain: Chain, method: string, params: unknown[]): Promise<T> {
  return (await chain.pub.request({ method, params } as never)) as T;
}

async function main() {
  const { privateKey, org, rpc: rpcUrl } = settings();
  const admin = privateKeyToAccount(privateKey);
  const plan = orgPlan(org, miaAccount(privateKey).address);
  say(`Setting up ${plan.root} on ENSv2 (Sepolia) · admin ${admin.address} · RPC ${rpcUrl}`);
  const chain = await connect(rpcUrl);
  const { pub } = chain;
  const sender = new Sender(chain, admin, check);

  if (chain.local && (await hasCode(pub, admin.address))) {
    // Anvil's dev accounts carry EIP-7702 code on Sepolia, which rejects the ERC-1155 mint callback.
    await rpc(chain, "anvil_setCode", [admin.address, "0x"]);
    check("cleared the admin's EIP-7702 code on this local fork (names are ERC-1155 tokens)");
  }
  const balance = await pub.getBalance({ address: admin.address });
  say(`  Admin balance: ${Number(formatEther(balance)).toFixed(4)} ETH`);
  if (balance === 0n) throw new UserError(`The admin ${admin.address} has no Sepolia ETH. Fund it first (about 0.05 ETH is plenty).`);

  // Every address is known before anything is deployed (CREATE2), so steps can go out together.
  const resolver = await resolverAddress(pub, admin.address);
  // A level that already has a subname registry the admin controls (e.g. set up in the portal) keeps it.
  const registry = new Map<string, Address>();
  for (const l of plan.levels) {
    const parentRegistry = l.parent ? registry.get(l.parent)! : ETH_REGISTRY;
    const existing = (await readEntry(pub, parentRegistry, l.label)).subregistry;
    if (existing && !(await hasRootRoles(pub, existing, RegistryRoles.ROLE_REGISTRAR, admin.address))) {
      throw new UserError(`${l.name} already has a subname registry (${existing}) that the admin doesn't control. Fix it in the portal, then re-run.`);
    }
    registry.set(l.name, existing ?? (await registryAddress(pub, admin.address, l.name)));
  }
  const reg = (name: string) => registry.get(name)!;

  say("\nCompany name");
  const rootEntry = await readEntry(pub, ETH_REGISTRY, org);
  if (rootEntry.registered && rootEntry.owner && !isAddressEqual(rootEntry.owner, admin.address)) {
    throw new UserError(`${plan.root} belongs to ${rootEntry.owner}, not the admin. Pick another ORG_LABEL.`);
  }
  if (rootEntry.registered) {
    check(`${plan.root} is the admin's (expires ${new Date(rootEntry.expiry * 1000).toISOString().slice(0, 10)})`);
  } else {
    await registerRoot(chain, sender, privateKey, org, reg(plan.root), resolver, { check, say });
  }

  const expiry = (await chainNow(pub)) + 365 * DAY;
  const ownedBy = async (registryAddr: Address, label: string, name: string, owner: Address) => {
    const e = await readEntry(pub, registryAddr, label);
    if (e.registered && e.owner && !isAddressEqual(e.owner, owner)) {
      throw new UserError(`${name} is registered to ${e.owner}, not ${owner}. Remove it in the portal, then re-run.`);
    }
    return e.registered;
  };
  const subregistryIs = async (registryAddr: Address, label: string, target: Address) => {
    const e = await readEntry(pub, registryAddr, label);
    return !!e.subregistry && isAddressEqual(e.subregistry, target);
  };
  const bundleStep = (id: string, name: string, bundle: OrgLevel["bundle"]): Step => ({
    id,
    title: `limits for ${name}: ${describeBundle(bundle)}`,
    deps: ["resolver"],
    done: async () => (await bundleWrites(pub, resolver, name, bundle)).length === 0,
    tx: async () => {
      const calls = await bundleWrites(pub, resolver, name, bundle);
      return calls.length ? tx.resolverMulticall(resolver, calls) : null;
    },
  });

  const steps: Step[] = [
    { id: "resolver", title: `deploy the admin's resolver ${resolver}`, done: () => hasCode(pub, resolver), tx: () => tx.deployResolver(admin.address) },
    {
      id: "root-resolver",
      title: `use it for ${plan.root}`,
      done: async () => {
        const e = await readEntry(pub, ETH_REGISTRY, org);
        return !!e.resolver && isAddressEqual(e.resolver, resolver);
      },
      tx: () => tx.setResolver(ETH_REGISTRY, org, resolver),
    },
  ];
  for (const l of plan.levels) {
    const own = reg(l.name);
    // The company sits in ETHRegistry; every other level in its parent's UserRegistry.
    const parentRegistry = l.parent ? reg(l.parent) : ETH_REGISTRY;
    steps.push({ id: `reg:${l.name}`, title: `deploy the registry for ${l.name}`, done: () => hasCode(pub, own), tx: () => tx.deployRegistry(admin.address, l.name) });
    if (l.parent) {
      steps.push({
        id: `entry:${l.name}`,
        title: `add ${l.name} with its registry attached`,
        deps: [`reg:${l.parent}`],
        done: () => ownedBy(parentRegistry, l.label, l.name, admin.address),
        // Passing the level's own registry here attaches it in the same transaction.
        tx: () => tx.register(parentRegistry, l.label, admin.address, own, resolver, RegistryRoles.ROLE_SET_SUBREGISTRY, expiry),
      });
    }
    steps.push({
      id: `sub:${l.name}`,
      title: `attach ${l.name}'s registry (setSubregistry)`,
      deps: l.parent ? [`entry:${l.name}`] : [],
      done: () => subregistryIs(parentRegistry, l.label, own),
      tx: () => tx.setSubregistry(parentRegistry, l.label, own),
    });
    steps.push({
      id: `parent:${l.name}`,
      title: `point ${l.name}'s registry back at its parent (setParent)`,
      deps: [`reg:${l.name}`],
      done: async () => parentIs(await readParent(pub, own), parentRegistry, l.label),
      tx: () => tx.setParent(own, parentRegistry, l.label),
    });
    steps.push(bundleStep(`bundle:${l.name}`, l.name, l.bundle));
  }

  // The alias: an entry in growth's registry whose subregistry is the launch squad's registry.
  // Its registry keeps pointing at dev (setParent), so findCanonicalName only returns launch.dev….
  const { alias, mia } = plan;
  const growthRegistry = reg(alias.parent);
  steps.push(
    {
      id: "entry:alias",
      title: `add ${alias.name}, an alias whose registry is ${alias.target}'s`,
      deps: [`reg:${alias.parent}`],
      done: () => ownedBy(growthRegistry, alias.label, alias.name, admin.address),
      tx: () => tx.register(growthRegistry, alias.label, admin.address, reg(alias.target), resolver, RegistryRoles.ROLE_SET_SUBREGISTRY, expiry),
    },
    {
      id: "sub:alias",
      title: `attach the launch squad's registry under ${alias.name}`,
      deps: ["entry:alias"],
      done: () => subregistryIs(growthRegistry, alias.label, reg(alias.target)),
      tx: () => tx.setSubregistry(growthRegistry, alias.label, reg(alias.target)),
    },
    bundleStep("bundle:alias", alias.name, alias.bundle),
    {
      // Earlier versions gave mia a key anyone can compute; the admin holds every role on the squad's registry, so it can clear her.
      id: "entry:mia-legacy",
      title: `remove ${mia.name} held by the old public test key ${LEGACY_MIA}`,
      deps: [`reg:${mia.parent}`],
      done: async () => {
        const e = await readEntry(pub, reg(mia.parent), mia.label);
        return !(e.registered && e.owner && isAddressEqual(e.owner, LEGACY_MIA));
      },
      tx: () => tx.unregister(reg(mia.parent), mia.label),
    },
    {
      id: "entry:mia",
      title: `add ${mia.name} (owner ${mia.owner})`,
      deps: [`reg:${mia.parent}`, "entry:mia-legacy"],
      done: () => ownedBy(reg(mia.parent), mia.label, mia.name, mia.owner),
      tx: () => tx.register(reg(mia.parent), mia.label, mia.owner, zeroAddress, resolver, 0n, expiry),
    },
    bundleStep("bundle:mia", mia.name, mia.bundle),
  );

  say("\nTree");
  const sent = await runSteps(sender, steps, { skipped: (t) => check(`${t} (already done)`) });

  say(`\n${sent ? `Done (${sent} transactions).` : "Everything was already set up."}`);
  const printTree = (name: string, depth: number) => {
    const l = plan.levels.find((x) => x.name === name)!;
    say(`  ${"  ".repeat(depth)}${name}  ${describeBundle(l.bundle)}`);
    for (const c of plan.levels.filter((x) => x.parent === name)) printTree(c.name, depth + 1);
    if (name === mia.parent) say(`  ${"  ".repeat(depth + 1)}${mia.name}  ${describeBundle(mia.bundle)}`);
    if (name === alias.parent) say(`  ${"  ".repeat(depth + 1)}${alias.name}  alias of ${alias.target} · ${describeBundle(alias.bundle)}`);
  };
  printTree(plan.root, 0);
  say("\nPut these in .env.local:");
  say(`RELAY_ROOT_NAME=${plan.root}`);
  say(`RELAY_ROOT_OWNER=${admin.address}`);
}

main().catch((err) => {
  console.error(`\nerror: ${err instanceof UserError ? err.message : `${formatError(err) || shortError(err)}`}`);
  if (process.env.DEBUG && !(err instanceof UserError)) console.error(err);
  process.exitCode = 1;
});
