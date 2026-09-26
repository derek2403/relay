// npm run demo:reset: sets up the next demo round.
//
//  1. Removes (unregisters) every name the demo added under the teams, keeping what org-setup made
//     (the launch squad, its alias and mia) and, when org/<org>.json exists (npm run org:seed),
//     every seeded employee (and so their agents and subagents) and every alias it lists.
//  2. Asks the relay (POST /api/relay/admin/reset {"chain": true}, RELAY_ADMIN_TOKEN) to clear spend
//     for names that no longer exist, archive the round's chain proposals, task runs and incidents
//     (kept for the audit trail, left out of Approvals), reset the chain allowance ledger (never an
//     in-flight payment's hold) and lift suspensions and overlays of removed names.
//  3. Deletes RELAY_HOME (the CLI's keys) and what Codex made in demo-workspace/ (everything but
//     relay, AGENTS.md and .agents/).
//  4. Unlinks every relay-deployed escrow (relay-escrow-<n>) from MultiBaas, keeping relay-token and
//     relay-vault, so the plan's linked-contracts cap never fills up.
//  5. Re-emits the treasury seed history (npm run chain:setup -- --reseed) with --reseed, or when the
//     newest seeded transfer MultiBaas returns for the vault is older than 48 h (or there is none).
//  6. Tops up the relay signer (org/chain.json) from the funder when it has less than 0.01 ETH.
//  7. Prints a readiness checklist.
// The company, departments and teams stay. A removed label can be added again: a re-registered
// name gets a new resource, so it starts with no spend.
//
// Env: ADMIN_PRIVATE_KEY, ORG_LABEL (or RELAY_ROOT_NAME from .env.local), RELAY_ADMIN_TOKEN, the
// relay URL (RELAY_URL, else RELAY_PUBLIC_URL, else http://localhost:3000), the RPC (RELAY_RPC_URL,
// NEXT_PUBLIC_SEPOLIA_RPC_URL, else a public one) and, from .env.local, MULTIBAAS_URL,
// MULTIBAAS_API_KEY, FUNDER_PRIVATE_KEY and RELAY_ROOT_OWNER.
// Flags: --yes deletes RELAY_HOME and the workspace files without asking; --keep-home leaves
// RELAY_HOME; --reseed / --no-reseed force or skip step 5; --plan (--dry-run) changes nothing.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { type Address, type Hex, type LocalAccount, formatEther, isHex, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { type ChainWorkspace, NETWORK, explorerTx, loadChainWorkspace } from "../lib/chain/config";
import type { ChainResetResult } from "../lib/chain/reset";
import { formatError } from "../lib/ens/errors";
import { tryNormalize } from "../lib/ens/names";
import { RegistryRoles } from "../lib/ens/roles";
import { type MultiBaas, MultiBaasError, multibaas, signMbTx, summarizeReceipt } from "../lib/multibaas/client";
import { createChainReader, isScanLimitError } from "../lib/relay/ens";
import type { ChildView } from "../lib/relay/types";
import { formatStd, privateKey } from "./lib/chain-setup";
import {
  type Check,
  MIN_VAULT_STD,
  OWNER_TRANSFER_SIG,
  RESEED_AFTER_HOURS,
  RESET_USAGE,
  ResetArgsError,
  SIGNER_MIN_WEI,
  SIGNER_TOPUP_WEI,
  ageText,
  allReady,
  checkLine,
  demoMember,
  ESCROW_ALIAS,
  escrowLinks,
  ethText,
  linkedSlots,
  needsTopUp,
  newestEventMs,
  parseResetArgs,
  providerCheck,
  shouldReseed,
} from "./lib/demo-reset";
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
import { loadSeedSpec, resetSweep } from "./lib/org-seed";

/** What `./relay codex` keeps in demo-workspace/ (the same list .gitignore keeps). */
const WORKSPACE_KEEP = new Set(["relay", "AGENTS.md", ".agents"]);

const say = (line = "") => console.log(line);
const check = (line: string) => say(`  ✓ ${line}`);
const warn = (line: string) => say(`  ✗ ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function settings() {
  const args = parseResetArgs(process.argv.slice(2));
  if (args.help) {
    say(RESET_USAGE);
    process.exit(0);
  }
  loadEnvFiles([
    "RELAY_RPC_URL",
    "RELAY_LOGS_RPC_URL",
    "NEXT_PUBLIC_SEPOLIA_RPC_URL",
    "RELAY_ROOT_NAME",
    "RELAY_PUBLIC_URL",
    "RELAY_ADMIN_TOKEN",
    "MULTIBAAS_URL",
    "MULTIBAAS_API_KEY",
    "FUNDER_PRIVATE_KEY",
    "RELAY_ROOT_OWNER",
    "RELAY_CHAIN_CONFIG",
    "RELAY_DATA_DIR",
  ]);
  const key = process.env.ADMIN_PRIVATE_KEY?.trim();
  if (!key) throw new UserError("Set ADMIN_PRIVATE_KEY=0x… (the wallet that owns the teams).");
  const privateKeyHex = (key.startsWith("0x") ? key : `0x${key}`) as Hex;
  if (!isHex(privateKeyHex) || privateKeyHex.length !== 66) throw new UserError("ADMIN_PRIVATE_KEY must be a 32-byte hex private key.");
  const raw = process.env.ORG_LABEL?.trim() || process.env.RELAY_ROOT_NAME?.trim() || "";
  const org = tryNormalize(raw.replace(/\.eth$/, ""));
  if (!org || org.includes(".")) throw new UserError('Set ORG_LABEL (e.g. ORG_LABEL=acme), or RELAY_ROOT_NAME in .env.local.');
  const relay = (process.env.RELAY_URL?.trim() || process.env.RELAY_PUBLIC_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "").replace(/\/api\/relay$/, "");
  const home = path.resolve(process.env.RELAY_HOME?.trim() || path.join(os.homedir(), ".relay"));
  const mbUrl = process.env.MULTIBAAS_URL?.trim() || "";
  const mbKey = process.env.MULTIBAAS_API_KEY?.trim() || "";
  let funderKey: Hex | null = null;
  try {
    funderKey = privateKey(process.env.FUNDER_PRIVATE_KEY, "FUNDER_PRIVATE_KEY");
  } catch (err) {
    throw new UserError((err as Error).message);
  }
  return {
    ...args,
    privateKey: privateKeyHex,
    org,
    rpc: envRpc() || DEFAULT_RPC_URL,
    // Log scans (which names were added) need an RPC without a tiny getLogs range, like the relay's.
    logsRpc: process.env.RELAY_LOGS_RPC_URL?.trim() || envRpc() || DEFAULT_RPC_URL,
    relay,
    home,
    adminToken: process.env.RELAY_ADMIN_TOKEN?.trim() || "",
    mb: mbUrl && mbKey ? multibaas({ url: mbUrl, key: mbKey }) : null,
    funderKey,
  };
}

type Settings = ReturnType<typeof settings>;

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** What the steps found, for the checklist at the end. */
type Round = {
  root: string;
  ws: ChainWorkspace | null;
  chainId: number | null;
  /** Newest seeded treasury transfer (ms), null = none, undefined = not read. */
  newestSeedMs?: number | null;
  seedError?: string;
};

async function main() {
  const s = settings();
  const admin = privateKeyToAccount(s.privateKey);
  const plan = orgPlan(s.org, miaAccount(s.privateKey).address);
  say(`Resetting the demo under ${plan.root} · admin ${admin.address} · relay ${s.relay}${s.plan ? " · plan only (nothing is sent or deleted)" : ""}`);
  say("  1. remove the names demos added under the teams");
  say("  2. relay: clear their spend, archive the round's proposals, task runs and incidents, reset chain allowances");
  say("  3. delete the CLI's keys and what Codex made in demo-workspace/");
  say("  4. MultiBaas: unlink the relay's escrows (relay-token and relay-vault stay)");
  say(
    `  5. treasury: ${s.reseed === "force" ? "re-emit the seed history (--reseed)" : s.reseed === "skip" ? "keep the seed history (--no-reseed)" : `re-emit the seed history if it is older than ${RESEED_AFTER_HOURS} h`}`,
  );
  say(`  6. relay signer: top up ${ethText(SIGNER_TOPUP_WEI)} if it has less than ${ethText(SIGNER_MIN_WEI)}`);
  say("  7. readiness checklist");

  const chain = await connect(s.rpc);
  const reader = createChainReader(s.rpc, s.logsRpc);
  const round: Round = { root: plan.root, ws: loadChainWorkspace(), chainId: null };

  await removeNames(s, admin, plan, chain, reader);
  await relayReset(s);
  await cleanLocal(s);
  await multibaasSteps(s, round);

  say("\nReadiness");
  const checks = await readiness(s, round, reader);
  for (const c of checks) say(checkLine(c));
  const ready = allReady(checks);
  say(`\n${s.plan ? "Plan only: nothing was changed." : ready ? "Ready for the next round." : "Not ready yet: fix the ✗ items above."}`);
  if (!ready && !s.plan) process.exitCode = 1;
}

// --- 1. Names -----------------------------------------------------------------------------------------

async function removeNames(s: Settings, admin: LocalAccount, plan: ReturnType<typeof orgPlan>, chain: Awaited<ReturnType<typeof connect>>, reader: ReturnType<typeof createChainReader>) {
  const { pub } = chain;
  // The team registries (and the launch squad's): the ones actually attached, which org-setup may have
  // kept from the portal instead of deploying its own. A seeded company (org/<org>.json from
  // npm run org:seed) adds its teams, keeping the employees it lists; org-setup's teams are then
  // optional (skipped quietly when that tree isn't there).
  const spec = loadSeedSpec(s.org);
  const sweep = resetSweep(plan, spec);
  const targets: { parent: string; child: ChildView; registry: Address }[] = [];
  say(`\nLooking for names added during demos${spec ? ` (keeping the seeded names in org/${s.org}.json)` : ""}`);
  let notSetUp = 0;
  for (const { parent, keep, source, optional } of sweep) {
    const { levels, broken } = await walkName(pub, parent);
    const registry = broken ? null : (levels.at(-1)?.entry?.subregistry ?? null);
    if (!registry || !(await hasCode(pub, registry))) {
      if (optional) notSetUp++;
      else say(`  - ${parent}: no registry (run npm run ${source === "org-seed" ? "org:seed" : "org:setup"})`);
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
    const remove = children.filter((c) => c.status === "registered" && !keep.has(c.label));
    for (const c of remove) targets.push({ parent, child: c, registry });
    const kept = children.filter((c) => c.status === "registered" && keep.has(c.label)).map((c) => c.label);
    say(`  ${parent}: ${remove.length ? remove.map((c) => c.label).join(", ") : "nothing to remove"}${kept.length ? ` (keeping ${kept.join(", ")})` : ""}`);
  }
  if (notSetUp) say(`  - org-setup's teams and launch squad aren't set up under ${plan.root} (${notSetUp} skipped); the seeded teams were checked`);

  if (!targets.length) return say("  nothing was registered under the teams");
  if (s.plan) return say(`  would remove ${plural(targets.length, "name")}: ${targets.map((t) => t.child.name).join(", ")}`);
  say("\nRemoving");
  const sender = new Sender(chain, admin, check);
  // The admin holds every role on the team registries it deployed, so it can unregister any label there.
  await sender.sendAll(
    targets.map((t) => ({ title: `removed ${t.child.name}${t.child.owner ? ` (owner ${t.child.owner})` : ""}`, call: tx.unregister(t.registry, t.child.label) })),
  );
}

// --- 2. Relay -----------------------------------------------------------------------------------------

type ResetBody = { cleared?: string[]; keys?: number; chain?: ChainResetResult; error?: string; reason?: string };

async function relayReset(s: Settings) {
  say("\nRelay");
  if (s.plan) {
    say(`  - would POST ${s.relay}/api/relay/admin/reset {"chain": true}${s.adminToken ? "" : " (set RELAY_ADMIN_TOKEN: the relay refuses it without)"}`);
    return;
  }
  try {
    const res = await fetch(`${s.relay}/api/relay/admin/reset`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(s.adminToken ? { authorization: `Bearer ${s.adminToken}` } : {}) },
      body: JSON.stringify({ chain: true }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => null)) as ResetBody | null;
    if (!res.ok || !body?.cleared) {
      warn(`the relay answered ${res.status}: ${body?.reason ?? body?.error ?? "no details"}${s.adminToken ? "" : " (set RELAY_ADMIN_TOKEN)"}`);
      return;
    }
    check(`cleared spend for ${plural(body.cleared.length, "removed name")}${body.cleared.length ? `: ${body.cleared.join(", ")}` : ""}`);
    const c = body.chain;
    if (!c) return warn("the relay didn't reset chain state (it runs an older build: deploy this one)");
    const a = c.archived;
    check(`archived ${plural(a.proposals, "proposal")}, ${plural(a.runs, "task run")}, ${plural(a.incidents, "incident")} and ${plural(a.escrows, "escrow")} (kept for the audit trail)`);
    if (c.expired.proposals.length || c.expired.incidents.length) check(`expired the removed names' open items: ${[...c.expired.proposals, ...c.expired.incidents].join(", ")}`);
    check(`reset ${plural(c.ledger.reset, "allowance bucket")}${c.ledger.released.length ? `, released ${plural(c.ledger.released.length, "stale hold")}` : ""}`);
    if (c.ledger.held.length) say(`  - kept ${plural(c.ledger.held.length, "in-flight hold")}: ${c.ledger.held.join(", ")}`);
    if (c.inFlight.length) say(`  - still in flight (archived by the next reset once settled): ${c.inFlight.join(", ")}`);
    if (c.lifted.suspensions.length || c.lifted.overlays.length) check(`lifted ${[...c.lifted.suspensions, ...c.lifted.overlays].join(", ")}`);
    for (const k of c.skipped) say(`  - ${k.name}: ${k.reason}`);
  } catch (err) {
    warn(`could not reach the relay at ${s.relay} (${shortError(err)}); spend and chain state were not reset`);
  }
}

// --- 3. Local files ----------------------------------------------------------------------------------

async function cleanLocal(s: Settings) {
  say("\nCLI keys");
  if (s.keepHome) say(`  - kept ${s.home} (--keep-home)`);
  else if (!fs.existsSync(s.home)) check(`${s.home} does not exist`);
  else if (s.plan) say(`  - would delete ${s.home}`);
  else if (s.yes || (await confirm(`Delete ${s.home} (the CLI's keys and session)?`))) {
    fs.rmSync(s.home, { recursive: true, force: true });
    check(`deleted ${s.home}`);
  } else say(`  - kept ${s.home} (pass --yes to delete it)`);

  say("\nWorkspace");
  const workspace = path.join(REPO_ROOT, "demo-workspace");
  const made = fs.existsSync(workspace) ? fs.readdirSync(workspace).filter((f) => !WORKSPACE_KEEP.has(f)) : [];
  if (!made.length) check("demo-workspace/ has nothing from earlier runs");
  else if (s.plan) say(`  - would delete ${made.join(", ")} from demo-workspace/`);
  else if (s.yes || (await confirm(`Delete what Codex made in demo-workspace/ (${made.join(", ")})?`))) {
    for (const f of made) fs.rmSync(path.join(workspace, f), { recursive: true, force: true });
    check(`deleted ${made.join(", ")} from demo-workspace/`);
  } else say(`  - kept ${made.join(", ")} (pass --yes to delete them)`);
}

// --- 4–6. MultiBaas ----------------------------------------------------------------------------------

const mbError = (err: unknown) => (err instanceof MultiBaasError ? err.message : shortError(err));

async function multibaasSteps(s: Settings, round: Round) {
  say("\nMultiBaas");
  const mb = s.mb;
  if (!mb) return warn("MULTIBAAS_URL and MULTIBAAS_API_KEY aren't set (.env.local): escrows, treasury and signer steps skipped");
  try {
    const st = await mb.status();
    round.chainId = st.chainID;
    if (st.chainID !== NETWORK.chainId) return warn(`MultiBaas is on chain ${st.chainID}, not Sepolia; skipped`);
  } catch (err) {
    return warn(`MultiBaas unreachable (${mbError(err)}); skipped`);
  }
  const ws = round.ws;
  if (!ws) return warn("no org/chain.json: run npm run chain:setup first");

  // 4. Escrows.
  try {
    // The address list leaves out what each address is linked to; an escrow alias's details say.
    const listed = await mb.listAddresses();
    const detailed = await Promise.all(
      listed.map(async (a) => (ESCROW_ALIAS.test(a?.alias ?? "") && !a.contracts?.length ? ((await mb.getAddress(a.alias!).catch(() => null)) ?? a) : a)),
    );
    const links = escrowLinks(detailed, [ws.token.address, ws.vault.address]);
    if (!links.length) check("no relay escrows linked");
    for (const l of links) {
      for (const label of l.labels) {
        if (s.plan) {
          say(`  - would unlink ${label} from ${l.ref} (${l.address})`);
          continue;
        }
        try {
          await mb.unlink(l.ref, label);
          check(`unlinked ${label} from ${l.ref} (${l.address})`);
        } catch (err) {
          warn(`could not unlink ${label} from ${l.ref}: ${mbError(err)}`);
        }
      }
    }
  } catch (err) {
    warn(`could not list MultiBaas addresses: ${mbError(err)}`);
  }

  // 5. Treasury seed history.
  say("\nTreasury");
  await readSeedAge(mb, ws, round);
  const now = Date.now();
  if (round.seedError) say(`  - couldn't read the vault's events (${round.seedError})${s.reseed === "auto" ? "; pass --reseed to re-emit the history anyway" : ""}`);
  else say(`  newest seeded transfer: ${ageText(round.newestSeedMs ?? null, now)}`);
  const reseed = round.seedError ? s.reseed === "force" : shouldReseed(s.reseed, round.newestSeedMs ?? null, now);
  if (!reseed) check(s.reseed === "skip" ? "kept (--no-reseed)" : `recent enough (under ${RESEED_AFTER_HOURS} h)`);
  else {
    say(`  → npm run chain:setup -- --reseed${s.plan ? " --plan" : ""}`);
    const tsx = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
    const r = spawnSync(tsx, [path.join(REPO_ROOT, "scripts", "chain-setup.ts"), "--reseed", ...(s.plan ? ["--plan"] : [])], { cwd: REPO_ROOT, stdio: "inherit", env: process.env });
    if (r.status !== 0) warn(`the reseed failed${r.error ? ` (${r.error.message})` : ""}; see above`);
    else if (!s.plan) {
      check("treasury history re-emitted");
      // MultiBaas indexes the new events within a few blocks.
      for (let i = 0; i < 6; i++) {
        await readSeedAge(mb, ws, round);
        if (round.newestSeedMs && Date.now() - round.newestSeedMs < 3600_000) break;
        await sleep(5_000);
      }
    }
  }

  // 6. Relay signer gas.
  say("\nRelay signer");
  try {
    const bal = await mb.balance(ws.signer);
    if (!needsTopUp(bal)) return check(`${ws.signer} has ${ethText(bal)}`);
    if (s.plan) return say(`  - would send ${ethText(SIGNER_TOPUP_WEI)} from the funder to ${ws.signer} (has ${ethText(bal)})`);
    if (!s.funderKey) return warn(`${ws.signer} has ${ethText(bal)}; set FUNDER_PRIVATE_KEY to top it up`);
    const hash = await topUp(mb, round.chainId!, privateKeyToAccount(s.funderKey), ws.signer);
    check(`sent ${ethText(SIGNER_TOPUP_WEI)} to ${ws.signer} (had ${ethText(bal)}) · ${explorerTx(ws, hash)}`);
  } catch (err) {
    warn(`signer top-up failed: ${mbError(err)}`);
  }
}

/** Reads the vault's OwnerTransfer events (only the seed sends them) and records the newest one's time. */
async function readSeedAge(mb: MultiBaas, ws: ChainWorkspace, round: Round) {
  try {
    const events = await mb.events({ contract_address: ws.vault.address, event_signature: OWNER_TRANSFER_SIG, limit: 50 });
    round.newestSeedMs = newestEventMs(Array.isArray(events) ? events : []);
    round.seedError = undefined;
  } catch (err) {
    round.seedError = mbError(err);
  }
}

/** Sends SIGNER_TOPUP_WEI from the funder to `to` through MultiBaas and waits for the receipt (up to 4 min). */
async function topUp(mb: MultiBaas, chainId: number, funder: LocalAccount, to: Address): Promise<Hex> {
  const have = await mb.balance(funder.address);
  if (have < SIGNER_TOPUP_WEI + parseUnits("0.001", 18)) throw new UserError(`the funder ${funder.address} has ${ethText(have)}`);
  const signed = await signMbTx(funder, await mb.transferEth(funder.address, to, SIGNER_TOPUP_WEI.toString()), chainId);
  try {
    await mb.submit(signed.serialized);
  } catch (err) {
    // A refused submit whose hash MultiBaas doesn't know was not sent; anything else may have been.
    if (err instanceof MultiBaasError && err.kind === "http" && !(await mb.tx(signed.hash).catch(() => null))) throw err;
  }
  const until = Date.now() + 4 * 60_000;
  for (;;) {
    const r = await mb.receipt(signed.hash).catch(() => null);
    if (r) {
      if (summarizeReceipt(r).status !== "success") throw new UserError(`the top-up reverted: ${signed.hash}`);
      return signed.hash;
    }
    if (Date.now() > until) throw new UserError(`no receipt for ${signed.hash} after 4 min (it may still land; check the explorer before running again)`);
    await sleep(4_000);
  }
}

// --- 7. Readiness ------------------------------------------------------------------------------------

async function getJson<T>(url: string): Promise<{ ok: true; body: T } | { ok: false; why: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as T | null;
    if (!res.ok || body === null) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, body };
  } catch (err) {
    return { ok: false, why: shortError(err) };
  }
}

type RelayStatus = { root?: string | null; providers?: unknown; world?: { configured?: boolean; environment?: string; problems?: string[] } };
type ChainStatus = { configured?: boolean; block?: number | null; problems?: string[]; vault?: { balance?: string | null } | null; signerBalance?: string | null };

async function readiness(s: Settings, round: Round, reader: ReturnType<typeof createChainReader>): Promise<Check[]> {
  const checks: Check[] = [];
  const api = `${s.relay}/api/relay`;
  const [status, chainStatus, proposals, incidents] = await Promise.all([
    getJson<RelayStatus>(`${api}/status`),
    getJson<ChainStatus>(`${api}/chain/status`),
    getJson<{ proposals?: { id: string; state?: string }[] }>(`${api}/chain/proposals?all=1`),
    getJson<{ incidents?: { id: string; state?: string }[] }>(`${api}/approvals/incidents`),
  ]);

  checks.push(status.ok ? { ok: true, label: "Relay", detail: `${s.relay} reachable (root ${status.body.root ?? "not set"})` } : { ok: false, label: "Relay", detail: `${s.relay}/api/relay/status: ${status.why}` });
  if (chainStatus.ok) {
    const c = chainStatus.body;
    checks.push({ ok: c.configured === true, label: "Blockchain", detail: c.configured ? `configured, block ${c.block}` : (c.problems ?? []).join("; ") || "not configured" });
  } else checks.push({ ok: false, label: "Blockchain", detail: `/chain/status: ${chainStatus.why}` });

  // Vault and signer: read fresh from MultiBaas (the relay caches its status for 30 s), else from the relay.
  const ws = round.ws;
  let vaultStd: string | null = chainStatus.ok ? (chainStatus.body.vault?.balance ?? null) : null;
  let signerEth: string | null = chainStatus.ok ? (chainStatus.body.signerBalance ?? null) : null;
  if (s.mb && ws) {
    vaultStd = await s.mb.tokenBalance(ws.token.address, ws.vault.address).then(formatStd, () => vaultStd);
    signerEth = await s.mb.balance(ws.signer).then(formatEther, () => signerEth);
  }
  checks.push(
    vaultStd === null
      ? { ok: false, label: "Vault", detail: "balance not readable" }
      : { ok: Number(vaultStd) >= MIN_VAULT_STD, label: "Vault", detail: `${vaultStd} STD (needs ${MIN_VAULT_STD})` },
  );
  checks.push(
    signerEth === null
      ? { ok: false, label: "Relay signer", detail: "balance not readable" }
      : { ok: Number(signerEth) >= Number(formatEther(SIGNER_MIN_WEI)), label: "Relay signer", detail: `${Number(signerEth).toFixed(4)} ETH (needs ${formatEther(SIGNER_MIN_WEI)})` },
  );

  const world = status.ok ? status.body.world : undefined;
  checks.push(
    !world
      ? { ok: false, label: "World ID", detail: "not reported by the relay" }
      : { ok: world.configured === true, label: "World ID", detail: world.configured ? `configured (${world.environment})` : (world.problems ?? []).join("; ") || "not configured" },
  );

  const now = Date.now();
  checks.push(
    round.seedError || round.newestSeedMs === undefined
      ? { ok: false, label: "Treasury history", detail: round.seedError ?? "not read" }
      : {
          ok: shouldReseed("auto", round.newestSeedMs, now) === false,
          label: "Treasury history",
          detail: `newest seeded transfer ${ageText(round.newestSeedMs, now)}${shouldReseed("auto", round.newestSeedMs, now) ? " (run with --reseed)" : ""}`,
        },
  );

  if (s.mb) {
    const slots = await s.mb.plan().then(linkedSlots, () => undefined);
    checks.push(
      slots === undefined
        ? { ok: null, label: "MultiBaas linked contracts", detail: "plan not readable with this key" }
        : slots === null || slots.free === null
          ? { ok: true, label: "MultiBaas linked contracts", detail: slots ? `${slots.count} used, no limit` : "no limit listed" }
          : { ok: slots.free >= 1, label: "MultiBaas linked contracts", detail: `${slots.count}/${slots.limit} used` },
    );
  } else checks.push({ ok: false, label: "MultiBaas linked contracts", detail: "MultiBaas not configured here" });

  checks.push(providerCheck("OpenAI", status.ok ? status.body.providers : null, ["codex", "openai-images"]));
  checks.push(providerCheck("Weather", status.ok ? status.body.providers : null, ["weather"]));

  const derek = demoMember(round.root);
  try {
    const leaf = (await reader.readLevels(round.root, derek)).at(-1);
    const there = leaf?.status === "registered";
    checks.push({ ok: !there, label: "Derek", detail: there ? `${derek} is still registered` : `${derek} absent (ready to add)` });
  } catch (err) {
    checks.push({ ok: false, label: "Derek", detail: `couldn't read ${derek}: ${shortError(err)}` });
  }

  const shown = [...(proposals.ok ? (proposals.body.proposals ?? []) : []), ...(incidents.ok ? (incidents.body.incidents ?? []) : [])];
  checks.push(
    !proposals.ok || !incidents.ok
      ? { ok: null, label: "Approvals", detail: `lists not read (${!proposals.ok ? proposals.why : ""}${!incidents.ok ? ` ${incidents.why}` : ""})`.replace("( ", "(") }
      : shown.length
        ? { ok: null, label: "Approvals", detail: `${plural(shown.length, "item")} still shown: ${shown.map((x) => `${x.id} ${x.state ?? ""}`.trim()).join(", ")}` }
        : { ok: true, label: "Approvals", detail: "empty" },
  );
  return checks;
}

main().catch((err) => {
  const msg = err instanceof UserError || err instanceof ResetArgsError ? err.message : formatError(err) || shortError(err);
  console.error(`\nerror: ${msg}`);
  if (process.env.DEBUG && !(err instanceof UserError)) console.error(err);
  process.exitCode = 1;
});
