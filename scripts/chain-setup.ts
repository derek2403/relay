// npm run chain:setup: the MultiBaas workspace on Sepolia, through MultiBaas only.
//
//   1. upload relay-token, relay-vault and relay-escrow (ABI + bytecode, version 1.0)
//   2. deploy the Soda Test Dollar token and the policy vault (MultiBaas composes, the funder signs,
//      MultiBaas submits; each receipt is awaited before the next send)
//   3. alias and link both with startingBlock "latest" BEFORE seeding (the free plan indexes at
//      most 100 blocks back and keeps events 72 h)
//   4. mint 1000 STD to the vault, approve the supplier and contractor, seed three owner transfers
//      (12 → supplier, 7 → contractor, 250 → an unapproved address), fund the relay signer, then
//      hand the vault to RELAY_ROOT_OWNER
//   5. write org/chain.json (addresses and hashes only)
//
// Safe to re-run: it reads MultiBaas and the chain first and skips every finished step; a
// transaction whose receipt wasn't seen (crash, network) is looked up by hash, never re-sent.
// --plan prints the steps and the ETH needed and sends nothing. --reseed only re-emits the seed
// transfers (for demos more than 72 h after setup).

import { type Address, type Hex, type LocalAccount, formatGwei, isAddressEqual, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { CHAIN_ARTIFACTS } from "../lib/chain/artifacts";
import { NETWORK, chainConfigPath, explorerAddress, explorerTx, loadChainWorkspace } from "../lib/chain/config";
import { type MbTx, type MultiBaas, MultiBaasError, type ReceiptSummary, multibaas, signMbTx, summarizeReceipt } from "../lib/multibaas/client";
import {
  CONTRACT_VERSION,
  LABELS,
  type Label,
  OWNER_FUND_ETH,
  type Observed,
  type Progress,
  RECIPIENTS,
  SEED,
  SIGNER_FUND_ETH,
  SetupError,
  type Step,
  USAGE,
  VAULT_LIMITS,
  blockers,
  buildWorkspace,
  deriveRecipients,
  eth,
  ethNeeded,
  formatStd,
  maxFeeFor,
  parseArgs,
  planReseed,
  planSetup,
  progressPath,
  readProgress,
  setupEnv,
  std,
  writeProgress,
  writeWorkspace,
} from "./lib/chain-setup";
import { loadEnvFiles } from "./lib/ensv2";

const say = (line = "") => console.log(line);
const check = (line: string) => say(`  ✓ ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV_KEYS = [
  "MULTIBAAS_URL",
  "MULTIBAAS_API_KEY",
  "FUNDER_PRIVATE_KEY",
  "RELAY_ROOT_OWNER",
  "MULTIBAAS_SIGNER_PRIVATE_KEY",
  "VAULT_OWNER_PRIVATE_KEY",
  "ADMIN_PRIVATE_KEY",
  "RELAY_DATA_DIR",
  "RELAY_CHAIN_CONFIG",
];

type Ctx = {
  mb: MultiBaas;
  chainId: number;
  funder: LocalAccount;
  signer: Address;
  rootOwner: Address;
  recipients: Record<(typeof RECIPIENTS)[number], Address>;
  outsider: Address;
  progress: Progress;
  progressFile: string;
  dryRun: boolean;
};

const save = (c: Ctx) => {
  if (!c.dryRun) writeProgress(c.progressFile, c.progress);
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return say(USAGE);
  loadEnvFiles(ENV_KEYS);
  const env = setupEnv(process.env);
  const mb = multibaas({ url: env.mbUrl, key: env.mbKey });
  const funder = privateKeyToAccount(env.funderKey);

  const status = await mb.status();
  if (status.chainID !== NETWORK.chainId) throw new SetupError(`this MultiBaas deployment is on chain ${status.chainID}, not Sepolia (${NETWORK.chainId})`);
  say(`MultiBaas setup on Sepolia · block ${status.blockNumber} · funder ${funder.address}${args.plan ? " · plan only (nothing is sent)" : ""}`);
  await showPlanLimits(mb);

  let signerKey = env.signerKey;
  const generated = !signerKey;
  if (!signerKey) signerKey = generatePrivateKey();
  const signer = privateKeyToAccount(signerKey).address;
  const { recipients, outsider } = deriveRecipients(env.funderKey);
  const progressFile = progressPath(env.dataDir);
  const c: Ctx = {
    mb,
    chainId: status.chainID,
    funder,
    signer,
    rootOwner: env.rootOwner,
    recipients,
    outsider,
    progress: readProgress(progressFile, status.chainID, funder.address),
    progressFile,
    dryRun: args.plan,
  };
  say(`  relay signer ${generated ? "(not set yet)" : signer} · vault owner after setup ${env.rootOwner}`);
  say(`  recipients: supplier ${recipients.supplier} · contractor ${recipients.contractor} · unapproved ${outsider}`);

  await settlePending(c);

  const maxFee = maxFeeFor(BigInt(status.baseFee ?? "1000000000"));
  if (args.reseed) return reseed(c, env.ownerKeys, maxFee);

  let obs = await observe(c);
  const problems = blockers(obs);
  const steps = planSetup(obs);
  const need = ethNeeded(steps, maxFee);
  const funderBalance = await mb.balance(funder.address);
  say();
  if (!steps.length) say("Nothing to do: everything is in place.");
  else {
    say(`Plan (${steps.length} steps, ~${need.gas.toLocaleString("en-US")} gas, up to ${eth(need.wei)} at a ${Number(formatGwei(maxFee)).toFixed(2)} gwei fee cap):`);
    steps.forEach((s, i) => say(`  ${String(i + 1).padStart(2)}. ${s.what}`));
    say(`  funder balance ${eth(funderBalance)}`);
  }
  for (const p of problems) say(`  ✗ ${p}`);

  if (generated && args.plan) {
    say();
    say("No MULTIBAAS_SIGNER_PRIVATE_KEY is set: the real run generates the relay signer key, prints it once and stops so you can save it.");
    return;
  }
  if (generated) {
    say();
    say("No MULTIBAAS_SIGNER_PRIVATE_KEY is set. A new relay signer key was generated; put this line in .env.local");
    say("(and on the relay server), never in a committed file, then run npm run chain:setup again:");
    say();
    say(`MULTIBAAS_SIGNER_PRIVATE_KEY=${signerKey}`);
    say();
    if (!args.plan) process.exitCode = 2;
    return;
  }
  if (problems.length) throw new SetupError("fix the problems above, then run it again");
  if (args.plan) return;
  if (funderBalance < need.wei) throw new SetupError(`the funder has ${eth(funderBalance)}; the plan may need up to ${eth(need.wei)}`);

  // One step at a time, re-reading the state after each so a partial run resumes cleanly.
  const ran = new Set<string>();
  for (;;) {
    const next = planSetup(obs)[0];
    if (!next) break;
    if (ran.has(next.id)) {
      await sleep(6_000); // a read that lags the receipt by a block
      obs = await observe(c);
      if (planSetup(obs)[0]?.id === next.id) throw new SetupError(`step ${next.id} ran but the chain doesn't show it yet; run the setup again in a minute`);
      continue;
    }
    ran.add(next.id);
    await runStep(c, next, obs);
    obs = await observe(c);
  }

  const leftover = blockers(obs);
  if (leftover.length) throw new SetupError(leftover.join("; "));
  await finish(c, obs);
}

async function showPlanLimits(mb: MultiBaas) {
  try {
    const plan = await mb.plan();
    const lim = (n: string) => plan.limits.find((l) => l.name === n);
    const show = (n: string) => {
      const l = lim(n);
      return l ? `${n.replace(/_/g, " ")} ${l.count === undefined ? "" : `${l.count}/`}${l.limit ?? "∞"}` : null;
    };
    say(`  plan "${plan.name}": ${["linked_contracts", "api_calls_per_month", "past_logs_max_depth", "event_logging_retention_hours", "events_per_sec"].map(show).filter(Boolean).join(" · ")}`);
    const linked = lim("linked_contracts");
    if (linked?.limit != null && (linked.count ?? 0) + 2 > linked.limit) say(`  ! only ${linked.limit - (linked.count ?? 0)} linked contracts left on this plan`);
  } catch (e) {
    say(`  (plan limits not readable with this key: ${(e as Error).message})`);
  }
}

// --- Observe ------------------------------------------------------------------------------------------

const readFn = (c: Ctx, addr: Address, label: Label) => (method: string, args: unknown[] = []) =>
  c.mb.read(addr, label, method, args, { contractOverride: true });

const asAddress = (v: unknown, what: string): Address => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new SetupError(`${what} returned ${String(v)}`);
  return v as Address;
};

/** Where a labelled contract is: this funder's own deploy first (progress), else the MultiBaas alias. */
async function locate(c: Ctx, label: "relay-token" | "relay-vault") {
  const own = label === "relay-token" ? c.progress.token : c.progress.vault;
  const byAlias = await c.mb.getAddress(label);
  const address = own ?? byAlias?.address ?? null;
  if (!address) return null;
  const rec = own && byAlias && isAddressEqual(byAlias.address, own) ? byAlias : await c.mb.getAddress(address);
  return { address, aliased: rec?.alias === label, linked: !!rec?.contracts?.some((x) => x.label === label) };
}

async function observe(c: Ctx): Promise<Observed> {
  const uploads = {} as Observed["uploads"];
  for (const l of LABELS) {
    const got = await c.mb.getContract(l, CONTRACT_VERSION);
    uploads[l] = !got ? "missing" : (got.bin ?? "").toLowerCase() === CHAIN_ARTIFACTS[l].bytecode.toLowerCase() ? "same" : "different";
  }
  const vaultKey = () => (c.progress.vault ?? "").toLowerCase();

  let token: Observed["token"] = null;
  const t = await locate(c, "relay-token");
  if (t && uploads["relay-token"] === "same") {
    token = { ...t, owner: asAddress(await readFn(c, t.address, "relay-token")("owner"), "token.owner()") };
  } else if (t) say(`  (the token at ${t.address} is read after relay-token is uploaded)`);

  let vault: Observed["vault"] = null;
  const v = await locate(c, "relay-vault");
  if (v && uploads["relay-vault"] === "same") {
    const r = readFn(c, v.address, "relay-vault");
    const approved: Record<string, boolean> = {};
    for (const name of RECIPIENTS) approved[name] = (await r("approved", [c.recipients[name]])) === true;
    const tokenAddr = asAddress(await r("token"), "vault.token()");
    vault = {
      ...v,
      owner: asAddress(await r("owner"), "vault.owner()"),
      agent: asAddress(await r("agent"), "vault.agent()"),
      token: tokenAddr,
      paused: (await r("paused")) === true,
      balance: await c.mb.tokenBalance(tokenAddr, v.address),
      approved,
    };
    if (!c.progress.vault) c.progress.vault = v.address; // adopt the aliased vault for seed bookkeeping
  } else if (v) say(`  (the vault at ${v.address} is read after relay-vault is uploaded)`);

  // Seed evidence: this run's progress, plus org/chain.json when it describes the same vault.
  const seeded: Observed["seeded"] = { ...(c.progress.seed[vaultKey()] ?? {}) };
  const ws = loadChainWorkspace();
  if (ws && vault && isAddressEqual(ws.vault.address, vault.address)) {
    for (const s of SEED) {
      const hit = ws.seed.txs.find((x) => x.what === s.what);
      if (hit && !seeded[s.key]) seeded[s.key] = hit.hash;
    }
  }
  return { funder: c.funder.address, signer: c.signer, rootOwner: c.rootOwner, uploads, token, vault, signerBalance: await c.mb.balance(c.signer), seeded };
}

// --- Send ---------------------------------------------------------------------------------------------

/** Waits for a receipt through MultiBaas (every 4 s, up to 6 min). */
async function waitReceipt(c: Ctx, hash: Hex, timeoutMs = 6 * 60_000): Promise<ReceiptSummary> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await c.mb.receipt(hash).catch((e) => {
      if (e instanceof MultiBaasError && (e.kind === "network" || e.kind === "timeout")) return null;
      throw e;
    });
    if (r) return summarizeReceipt(r);
    if (Date.now() > until) throw new SetupError(`no receipt for ${hash} after ${timeoutMs / 60_000} min; run the setup again later (it resumes from this hash)`);
    await sleep(4_000);
  }
}

function record(c: Ctx, step: string, r: ReceiptSummary) {
  const p = c.progress;
  p.done[step] = { hash: r.hash, block: r.blockNumber };
  if (step === "deploy:token" && r.contractAddress) p.token = r.contractAddress;
  if (step === "deploy:vault" && r.contractAddress) {
    p.vault = r.contractAddress;
    p.deployBlock = r.blockNumber;
  }
  const seed = step.match(/^seed:(\w+)$/);
  if (seed && p.vault) (p.seed[p.vault.toLowerCase()] ??= {})[seed[1] as (typeof SEED)[number]["key"]] = r.hash;
  const re = step.match(/^reseed:[^:]+:(\w+)$/);
  if (re && p.reseed) p.reseed.done[re[1]] = r.hash;
}

/** Signs a MultiBaas-composed transaction locally, submits it through MultiBaas and waits for the receipt. */
async function send(c: Ctx, step: string, account: LocalAccount, tx: MbTx): Promise<ReceiptSummary> {
  const signed = await signMbTx(account, tx, c.chainId);
  c.progress.pending = { step, hash: signed.hash };
  save(c);
  try {
    const sent = await c.mb.submit(signed.serialized);
    if (sent.hash !== signed.hash) say(`  ! MultiBaas reported hash ${sent.hash}, expected ${signed.hash}`);
  } catch (e) {
    const refused = e instanceof MultiBaasError && e.kind === "http";
    if (refused && !(await c.mb.tx(signed.hash).catch(() => null))) {
      c.progress.pending = null;
      save(c);
      throw e;
    }
    say(`  … submit answer unclear (${(e as Error).message}); waiting for ${signed.hash}`);
  }
  const r = await waitReceipt(c, signed.hash);
  c.progress.pending = null;
  record(c, step, r);
  save(c);
  if (r.status !== "success") throw new SetupError(`${step} reverted: ${explorerTx({ network: NETWORK }, r.hash)}`);
  return r;
}

/** A transaction from an earlier run whose receipt wasn't seen: settle it before planning. */
async function settlePending(c: Ctx) {
  const p = c.progress.pending;
  if (!p) return;
  say(`  resolving ${p.step} from the last run (${p.hash})`);
  const known = (await c.mb.receipt(p.hash)) ?? (await c.mb.tx(p.hash));
  if (!known) {
    say("  … it never reached the chain; it will be redone");
    c.progress.pending = null;
    save(c);
    return;
  }
  if (c.dryRun) return say("  … it is on the chain; a real run records it first");
  const r = await waitReceipt(c, p.hash);
  c.progress.pending = null;
  record(c, p.step, r);
  save(c);
  check(`${p.step} ${r.status === "success" ? "confirmed" : "REVERTED"} in block ${r.blockNumber}`);
}

// --- Steps --------------------------------------------------------------------------------------------

async function linkAndIndex(c: Ctx, label: "relay-token" | "relay-vault", address: Address) {
  const rec = await c.mb.getAddress(address);
  if (rec?.alias !== label) await c.mb.setAlias(address, label);
  if (!rec?.contracts?.some((x) => x.label === label)) {
    await c.mb.link(label, { label, version: CONTRACT_VERSION, startingBlock: "latest" });
  }
  for (let i = 0; i < 20; i++) {
    const s = await c.mb.indexingStatus(label, label).catch(() => null);
    if (s && !s.isProcessingPastLogs) return check(`${label} → ${address}, indexing from block ${s.startBlockNumber}`);
    await sleep(3_000);
  }
  say(`  ! ${label} is linked but still catching up on past logs; events appear shortly`);
}

async function runStep(c: Ctx, step: Step, o: Observed) {
  const f = c.funder.address;
  const token = o.token?.address ?? c.progress.token;
  const vault = o.vault?.address ?? c.progress.vault;
  const need = (a: Address | undefined, what: string) => {
    if (!a) throw new SetupError(`${step.id} needs the ${what} address`);
    return a;
  };
  const vaultCall = (method: string, args: unknown[]) => c.mb.prepare(need(vault, "vault"), "relay-vault", method, { args, from: f, contractOverride: true });

  say(`→ ${step.what}`);
  const done = (r: ReceiptSummary, extra = "") => check(`${step.id} in block ${r.blockNumber}${extra} · ${explorerTx({ network: NETWORK }, r.hash)}`);
  switch (step.id) {
    case "upload:relay-token":
    case "upload:relay-vault":
    case "upload:relay-escrow": {
      const a = CHAIN_ARTIFACTS[step.id.slice("upload:".length) as Label];
      const how = await c.mb.createContract(a.label, { contractName: a.contractName, version: CONTRACT_VERSION, rawAbi: a.abi, bin: a.bytecode });
      return check(`${a.label} ${CONTRACT_VERSION} ${how}`);
    }
    case "deploy:token": {
      const d = await c.mb.deploy("relay-token", CONTRACT_VERSION, { args: [f], from: f });
      const r = await send(c, step.id, c.funder, d.tx);
      if (!c.progress.token) (c.progress.token = d.deployAt), save(c);
      return done(r, ` → ${r.contractAddress ?? d.deployAt}`);
    }
    case "deploy:vault": {
      const args = [need(token, "token"), f, c.signer, std(VAULT_LIMITS.perTxMax).toString(), std(VAULT_LIMITS.periodLimit).toString(), String(VAULT_LIMITS.periodSeconds)];
      const d = await c.mb.deploy("relay-vault", CONTRACT_VERSION, { args, from: f });
      const r = await send(c, step.id, c.funder, d.tx);
      if (!c.progress.vault) (c.progress.vault = d.deployAt), (c.progress.deployBlock = r.blockNumber), save(c);
      return done(r, ` → ${r.contractAddress ?? d.deployAt}`);
    }
    case "link:token":
      return linkAndIndex(c, "relay-token", need(token, "token"));
    case "link:vault":
      return linkAndIndex(c, "relay-vault", need(vault, "vault"));
    case "set-agent":
      return done(await send(c, step.id, c.funder, await vaultCall("setAgent", [c.signer])));
    case "mint": {
      const tx = await c.mb.prepare(need(token, "token"), "relay-token", "mint", { args: [need(vault, "vault"), String(step.amount ?? 0n)], from: f, contractOverride: true });
      return done(await send(c, step.id, c.funder, tx));
    }
    case "approve:supplier":
    case "approve:contractor": {
      const name = step.id.slice("approve:".length) as (typeof RECIPIENTS)[number];
      return done(await send(c, step.id, c.funder, await vaultCall("setRecipient", [c.recipients[name], true])));
    }
    case "seed:supplier":
    case "seed:contractor":
    case "seed:outsider": {
      const s = SEED.find((x) => `seed:${x.key}` === step.id)!;
      const to = s.to === "outsider" ? c.outsider : c.recipients[s.to];
      return done(await send(c, step.id, c.funder, await vaultCall("ownerTransfer", [to, std(s.amount).toString()])));
    }
    case "fund-signer":
      return done(await send(c, step.id, c.funder, await c.mb.transferEth(f, c.signer, parseEther(SIGNER_FUND_ETH).toString())));
    case "transfer-ownership":
      return done(await send(c, step.id, c.funder, await vaultCall("transferOwnership", [c.rootOwner])));
    case "fund-owner":
      throw new SetupError("fund-owner is a reseed step");
  }
}

// --- Finish -------------------------------------------------------------------------------------------

async function finish(c: Ctx, o: Observed) {
  const t = o.token!;
  const v = o.vault!;
  const file = chainConfigPath();
  const existing = loadChainWorkspace();
  const same = existing && isAddressEqual(existing.vault.address, v.address) ? existing : null;
  let deployBlock = c.progress.deployBlock ?? same?.vault.deployBlock;
  if (deployBlock === undefined) {
    const s = await c.mb.indexingStatus("relay-vault", "relay-vault");
    deployBlock = s?.startBlockNumber ?? 0;
    say(`  (vault deploy block unknown; using the indexing start ${deployBlock})`);
  }
  const seedTxs = [...(same?.seed.txs ?? [])];
  for (const s of SEED) {
    const h = o.seeded[s.key];
    if (h && !seedTxs.some((x) => x.hash.toLowerCase() === h.toLowerCase())) seedTxs.push({ what: s.what, hash: h });
  }
  const missing = SEED.filter((s) => !o.seeded[s.key]);
  if (missing.length) say(`  ! the seed history is incomplete (${missing.map((s) => s.key).join(", ")}): run npm run chain:setup -- --reseed`);

  const ws = buildWorkspace({ token: t.address, vault: v.address, vaultOwner: v.owner, deployBlock, signer: c.signer, recipients: c.recipients, seedTxs });
  writeWorkspace(file, ws);
  check(`wrote ${file}`);

  const x = (a: string) => explorerAddress(ws, a);
  say();
  say("MultiBaas workspace ready:");
  say(`  token   ${ws.token.name} (${ws.token.symbol})  ${x(ws.token.address)}`);
  say(`  vault   ${formatStd(v.balance)} STD, owner ${v.owner}  ${x(ws.vault.address)}`);
  say(`  signer  ${ws.signer} (${eth(o.signerBalance)})  ${x(ws.signer)}`);
  for (const [name, a] of Object.entries(ws.recipients)) say(`  ${name.padEnd(7)} ${a}`);
  say(`  escrow template relay-escrow ${CONTRACT_VERSION}, bytecode ${ws.templates.escrow.bytecodeHash}`);
  for (const s of ws.seed.txs) say(`  seed    ${s.what}: ${explorerTx(ws, s.hash)}`);
}

// --- Reseed -------------------------------------------------------------------------------------------

async function reseed(c: Ctx, ownerKeys: Hex[], maxFee: bigint) {
  const ws = loadChainWorkspace();
  const vault = c.progress.vault ?? ws?.vault.address;
  const token = c.progress.token ?? ws?.token.address;
  if (!vault || !token) throw new SetupError("no vault yet: run npm run chain:setup first");
  const r = readFn(c, vault, "relay-vault");
  const owner = asAddress(await r("owner"), "vault.owner()");
  const paused = (await r("paused")) === true;
  const tokenOwner = asAddress(await readFn(c, token, "relay-token")("owner"), "token.owner()");
  const balance = await c.mb.tokenBalance(token, vault);
  const ownerAccount = isAddressEqual(owner, c.funder.address) ? c.funder : ownerKeys.map((k) => privateKeyToAccount(k)).find((a) => isAddressEqual(a.address, owner));
  if (!ownerAccount) throw new SetupError(`the vault is owned by ${owner}; set VAULT_OWNER_PRIVATE_KEY (or ADMIN_PRIVATE_KEY) to that wallet's key to reseed`);
  const ownerBalance = await c.mb.balance(owner);

  const resume = c.progress.reseed;
  const steps = planReseed({ vaultBalance: balance, paused, ownerIsFunder: ownerAccount === c.funder, ownerBalance, tokenOwnerIsFunder: isAddressEqual(tokenOwner, c.funder.address) }, maxFee).filter(
    (s) => !(resume && s.id.startsWith("seed:") && resume.done[s.id.slice(5)]),
  );
  const need = ethNeeded(steps, maxFee);
  say();
  say(`Reseed plan (vault ${vault}, ${formatStd(balance)} STD, owner ${owner}${resume ? `, resuming ${resume.id}` : ""}):`);
  steps.forEach((s, i) => say(`  ${String(i + 1).padStart(2)}. ${s.what}`));
  say(`  up to ${eth(need.wei)}`);
  if (c.dryRun) return;

  c.progress.reseed = resume ?? { id: new Date().toISOString().replace(/[-:]|\.\d+/g, ""), done: {} };
  save(c);
  const id = c.progress.reseed.id;
  for (const step of steps) {
    say(`→ ${step.what}`);
    let rc: ReceiptSummary;
    if (step.id === "fund-owner") {
      rc = await send(c, `reseed:${id}:fund-owner`, c.funder, await c.mb.transferEth(c.funder.address, owner, parseEther(OWNER_FUND_ETH).toString()));
    } else if (step.id === "mint") {
      const tx = await c.mb.prepare(token, "relay-token", "mint", { args: [vault, String(step.amount ?? 0n)], from: c.funder.address, contractOverride: true });
      rc = await send(c, `reseed:${id}:mint`, c.funder, tx);
    } else {
      const s = SEED.find((x) => `seed:${x.key}` === step.id)!;
      const to = s.to === "outsider" ? c.outsider : c.recipients[s.to];
      const tx = await c.mb.prepare(vault, "relay-vault", "ownerTransfer", { args: [to, std(s.amount).toString()], from: ownerAccount.address, contractOverride: true });
      rc = await send(c, `reseed:${id}:${s.key}`, ownerAccount, tx);
    }
    check(`in block ${rc.blockNumber} · ${explorerTx({ network: NETWORK }, rc.hash)}`);
  }

  const done = c.progress.reseed.done;
  if (ws && isAddressEqual(ws.vault.address, vault)) {
    const day = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
    const txs = [...ws.seed.txs];
    for (const s of SEED) {
      const h = done[s.key];
      if (h && !txs.some((x) => x.hash === h)) txs.push({ what: `${s.what}, reseeded ${day}`, hash: h });
    }
    writeWorkspace(chainConfigPath(), buildWorkspace({ token: ws.token.address, vault, vaultOwner: owner, deployBlock: ws.vault.deployBlock, signer: ws.signer, recipients: ws.recipients, seedTxs: txs }));
    check(`added the reseed to ${chainConfigPath()}`);
  } else say("  (no org/chain.json for this vault; the reseed hashes are in the progress file)");
  c.progress.reseed = null;
  save(c);
}

main().catch((e) => {
  const msg = e instanceof SetupError || e instanceof MultiBaasError ? e.message : ((e as Error)?.stack ?? String(e));
  console.error(`\nchain:setup failed: ${msg}`);
  process.exitCode = 1;
});

