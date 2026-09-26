// npm run demo:reset: undoes a demo run. Removes (unregisters) every name the demo added under
// the teams, keeping what org-setup made (the launch squad, its alias and mia), asks the relay to
// clear spend for names that no longer exist, deletes RELAY_HOME (the CLI's keys) and deletes what
// Codex made in demo-workspace/ (everything but relay, AGENTS.md and .agents/).
// The company, departments and teams stay. A removed label can be added again: a re-registered
// name gets a new resource, so it starts with no spend.
//
// Env: ADMIN_PRIVATE_KEY, ORG_LABEL (or RELAY_ROOT_NAME from .env.local), RELAY_ADMIN_TOKEN, the
// relay URL (RELAY_URL, else RELAY_PUBLIC_URL, else http://localhost:3000) and the RPC
// (RELAY_RPC_URL, NEXT_PUBLIC_SEPOLIA_RPC_URL, else a public one).
// Flags: --yes deletes RELAY_HOME and the workspace files without asking; --keep-home leaves RELAY_HOME.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { type Address, type Hex, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { formatError } from "../lib/ens/errors";
import { tryNormalize } from "../lib/ens/names";
import { RegistryRoles } from "../lib/ens/roles";
import { createChainReader, isScanLimitError } from "../lib/relay/ens";
import type { ChildView } from "../lib/relay/types";
import {
  DEFAULT_RPC_URL,
  REPO_ROOT,
  Sender,
  UserError,
  connect,
  envRpc,
  hasCode,
  hasRootRoles,
  loadEnvFiles,
  miaAccount,
  orgPlan,
  shortError,
  tx,
  walkName,
} from "./lib/ensv2";

/** What `./relay codex` keeps in demo-workspace/ (the same list .gitignore keeps). */
const WORKSPACE_KEEP = new Set(["relay", "AGENTS.md", ".agents"]);

const say = (line = "") => console.log(line);
const check = (line: string) => say(`  ✓ ${line}`);

function settings() {
  loadEnvFiles(["RELAY_RPC_URL", "NEXT_PUBLIC_SEPOLIA_RPC_URL", "RELAY_ROOT_NAME", "RELAY_PUBLIC_URL", "RELAY_ADMIN_TOKEN"]);
  const key = process.env.ADMIN_PRIVATE_KEY?.trim();
  if (!key) throw new UserError("Set ADMIN_PRIVATE_KEY=0x… (the wallet that owns the teams).");
  const privateKey = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!isHex(privateKey) || privateKey.length !== 66) throw new UserError("ADMIN_PRIVATE_KEY must be a 32-byte hex private key.");
  const raw = process.env.ORG_LABEL?.trim() || process.env.RELAY_ROOT_NAME?.trim() || "";
  const org = tryNormalize(raw.replace(/\.eth$/, ""));
  if (!org || org.includes(".")) throw new UserError('Set ORG_LABEL (e.g. ORG_LABEL=acme), or RELAY_ROOT_NAME in .env.local.');
  const relay = (process.env.RELAY_URL?.trim() || process.env.RELAY_PUBLIC_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "").replace(/\/api\/relay$/, "");
  const home = path.resolve(process.env.RELAY_HOME?.trim() || path.join(os.homedir(), ".relay"));
  const args = process.argv.slice(2);
  for (const a of args) if (!["--yes", "-y", "--keep-home"].includes(a)) throw new UserError(`Unknown option ${a}. Use --yes or --keep-home.`);
  return { privateKey, org, rpc: envRpc() || DEFAULT_RPC_URL, relay, home, adminToken: process.env.RELAY_ADMIN_TOKEN?.trim() || "", yes: args.includes("--yes") || args.includes("-y"), keepHome: args.includes("--keep-home") };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const s = settings();
  const admin = privateKeyToAccount(s.privateKey);
  const plan = orgPlan(s.org, miaAccount(s.privateKey).address);
  say(`Resetting the demo under ${plan.root} · admin ${admin.address}`);
  const chain = await connect(s.rpc);
  const { pub } = chain;
  const reader = createChainReader(s.rpc);

  // The team registries (and the launch squad's): the ones actually attached, which org-setup may have
  // kept from the portal instead of deploying its own.
  const sweep = [...plan.teams.map((t) => t.name), plan.launch];
  const targets: { parent: string; child: ChildView; registry: Address }[] = [];
  say("\nLooking for names added during demos");
  for (const parent of sweep) {
    const { levels, broken } = await walkName(pub, parent);
    const registry = broken ? null : (levels.at(-1)?.entry?.subregistry ?? null);
    if (!registry || !(await hasCode(pub, registry))) {
      say(`  - ${parent}: no registry (run npm run org:setup)`);
      continue;
    }
    if (!(await hasRootRoles(pub, registry, RegistryRoles.ROLE_UNREGISTER, admin.address))) {
      say(`  - ${parent}: its registry ${registry} isn't the admin's; skipped`);
      continue;
    }
    let children: ChildView[] | null = null;
    // Label lists come from the registry's events; a long first scan resumes where it stopped.
    for (let attempt = 0; !children; attempt++) {
      try {
        children = (await reader.listChildren(parent, { maxChunks: 400, deadlineMs: 120_000, maxLabels: 5000 })).children;
      } catch (err) {
        if (!isScanLimitError(err) || !err.retryable || attempt >= 5) throw new UserError(`Could not list the names under ${parent}: ${shortError(err)}`);
      }
    }
    const keep = plan.keep.get(parent) ?? new Set<string>();
    const remove = children.filter((c) => c.status === "registered" && !keep.has(c.label));
    for (const c of remove) targets.push({ parent, child: c, registry });
    const kept = children.filter((c) => c.status === "registered" && keep.has(c.label)).map((c) => c.label);
    say(`  ${parent}: ${remove.length ? remove.map((c) => c.label).join(", ") : "nothing to remove"}${kept.length ? ` (keeping ${kept.join(", ")})` : ""}`);
  }

  if (targets.length) {
    say("\nRemoving");
    const sender = new Sender(chain, admin, check);
    // The admin holds every role on the team registries it deployed, so it can unregister any label there.
    await sender.sendAll(
      targets.map((t) => ({ title: `removed ${t.child.name}${t.child.owner ? ` (owner ${t.child.owner})` : ""}`, call: tx.unregister(t.registry, t.child.label) })),
    );
  }

  say("\nRelay");
  try {
    const res = await fetch(`${s.relay}/api/relay/admin/reset`, {
      method: "POST",
      headers: s.adminToken ? { authorization: `Bearer ${s.adminToken}` } : {},
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => null)) as { cleared?: string[]; keys?: number; error?: string; reason?: string } | null;
    if (res.ok && body?.cleared) check(`cleared spend for ${body.cleared.length} removed name${body.cleared.length === 1 ? "" : "s"}${body.cleared.length ? `: ${body.cleared.join(", ")}` : ""}`);
    else say(`  ! the relay answered ${res.status}: ${body?.reason ?? body?.error ?? "no details"}${s.adminToken ? "" : " (set RELAY_ADMIN_TOKEN)"}`);
  } catch (err) {
    say(`  ! could not reach the relay at ${s.relay} (${shortError(err)}); spend for removed names was not cleared`);
  }

  say("\nCLI keys");
  if (s.keepHome) say(`  - kept ${s.home} (--keep-home)`);
  else if (!fs.existsSync(s.home)) check(`${s.home} does not exist`);
  else if (s.yes || (await confirm(`Delete ${s.home} (the CLI's keys and session)?`))) {
    fs.rmSync(s.home, { recursive: true, force: true });
    check(`deleted ${s.home}`);
  } else say(`  - kept ${s.home} (pass --yes to delete it)`);

  say("\nWorkspace");
  const workspace = path.join(REPO_ROOT, "demo-workspace");
  const made = fs.existsSync(workspace) ? fs.readdirSync(workspace).filter((f) => !WORKSPACE_KEEP.has(f)) : [];
  if (!made.length) check("demo-workspace/ has nothing from earlier runs");
  else if (s.yes || (await confirm(`Delete what Codex made in demo-workspace/ (${made.join(", ")})?`))) {
    for (const f of made) fs.rmSync(path.join(workspace, f), { recursive: true, force: true });
    check(`deleted ${made.join(", ")} from demo-workspace/`);
  } else say(`  - kept ${made.join(", ")} (pass --yes to delete them)`);

  say(`\n${targets.length ? `Removed ${targets.length} name${targets.length === 1 ? "" : "s"}.` : "Nothing was registered under the teams."} Ready for the next demo.`);
}

main().catch((err) => {
  console.error(`\nerror: ${err instanceof UserError ? err.message : formatError(err) || shortError(err)}`);
  if (process.env.DEBUG && !(err instanceof UserError)) console.error(err);
  process.exitCode = 1;
});
