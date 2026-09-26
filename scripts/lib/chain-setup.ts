// npm run chain:setup helpers: settings, derived recipients, the step plan (what is still to do,
// from what the chain and MultiBaas show), gas and ETH estimates, the progress file and the
// workspace file. Everything that decides is pure; the script (scripts/chain-setup.ts) observes
// and sends.

import fs from "node:fs";
import path from "node:path";

import { type Address, type Hex, concat, formatEther, getAddress, isAddress, isAddressEqual, keccak256, parseEther, parseUnits, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { CHAIN_ARTIFACTS } from "../../lib/chain/artifacts";
import { type ChainWorkspace, ESCROW_LABEL, NETWORK, TOKEN_META, VAULT_LABEL, serializeChainWorkspace } from "../../lib/chain/config";

export const CONTRACT_VERSION = "1.0";
export const LABELS = ["relay-token", "relay-vault", "relay-escrow"] as const;
export type Label = (typeof LABELS)[number];

/** Vault limits at deploy (whole STD) and the spending period. */
export const VAULT_LIMITS = { perTxMax: "10", periodLimit: "100", periodSeconds: 30 * 86_400 };
/** What the vault is minted at setup, and the monitor's "large transfer" threshold (whole STD). */
export const VAULT_MINT = "1000";
export const LARGE_TRANSFER = "50";
/** The relay signer's gas money, and the balance below which it is topped up again. */
export const SIGNER_FUND_ETH = "0.03";
export const SIGNER_MIN_ETH = "0.01";
/** Gas money for a vault owner that must sign a reseed but is nearly empty. */
export const OWNER_FUND_ETH = "0.005";

/** Named recipients the vault approves. */
export const RECIPIENTS = ["supplier", "contractor"] as const;
/** An address the vault never approves: the target of the large seeded payment. */
export const OUTSIDER = "outsider";

/** The seed history: vault owner transfers the monitor reviews (the last is large and unapproved). */
export const SEED = [
  { key: "supplier", to: "supplier", amount: "12", what: "12 STD to the supplier (approved)" },
  { key: "contractor", to: "contractor", amount: "7", what: "7 STD to the contractor (approved)" },
  { key: "outsider", to: OUTSIDER, amount: "250", what: "250 STD to an unapproved address (large, flagged)" },
] as const;
export const SEED_TOTAL = SEED.reduce((s, x) => s + parseUnits(x.amount, 18), 0n);

export const std = (amount: string) => parseUnits(amount, TOKEN_META.decimals);

export class SetupError extends Error {}

// --- Settings -------------------------------------------------------------------------------------

export type SetupArgs = { plan: boolean; reseed: boolean; help: boolean };

export function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { plan: false, reseed: false, help: false };
  for (const a of argv) {
    if (a === "--plan" || a === "--dry-run") out.plan = true;
    else if (a === "--reseed") out.reseed = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new SetupError(`unknown option ${a} (try --help)`);
  }
  return out;
}

export const USAGE = `npm run chain:setup [-- --plan] [-- --reseed]

  Deploys the Soda Test Dollar token and the policy vault on Sepolia through MultiBaas, uploads
  the approved escrow template, links and seeds them, and writes org/chain.json. Safe to re-run:
  it reads MultiBaas and the chain first and skips every finished step.

  --plan     print what would happen and the ETH needed; send nothing
  --reseed   only re-emit the seed history (MultiBaas keeps events for 72 h on the free plan)

  Env (.env.local): MULTIBAAS_URL, MULTIBAAS_API_KEY (admin), FUNDER_PRIVATE_KEY (deployer and gas),
  RELAY_ROOT_OWNER (final vault owner), MULTIBAAS_SIGNER_PRIVATE_KEY (the relay signer; generated
  and printed when missing). --reseed after the vault changed hands also needs the owner's key in
  VAULT_OWNER_PRIVATE_KEY or ADMIN_PRIVATE_KEY.`;

export type SetupEnv = {
  mbUrl: string;
  mbKey: string;
  funderKey: Hex;
  rootOwner: Address;
  /** null = not set yet (the script generates one and asks the operator to save it). */
  signerKey: Hex | null;
  /** Keys that may own the vault later (for --reseed). */
  ownerKeys: Hex[];
  dataDir: string;
};

/** Parses a 32-byte private key (with or without 0x); null when absent. */
export function privateKey(raw: string | undefined, name: string): Hex | null {
  const v = raw?.trim();
  if (!v) return null;
  const key = (v.startsWith("0x") ? v : `0x${v}`).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(key)) throw new SetupError(`${name} must be a 32-byte hex private key`);
  try {
    privateKeyToAccount(key as Hex);
  } catch {
    throw new SetupError(`${name} is not a valid private key`);
  }
  return key as Hex;
}

export function setupEnv(env: Record<string, string | undefined>): SetupEnv {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new SetupError(`Set ${k} in .env.local`);
    return v;
  };
  const mbUrl = need("MULTIBAAS_URL");
  const mbKey = need("MULTIBAAS_API_KEY");
  const funderKey = privateKey(need("FUNDER_PRIVATE_KEY"), "FUNDER_PRIVATE_KEY")!;
  const owner = need("RELAY_ROOT_OWNER");
  if (!isAddress(owner, { strict: false }) || BigInt(owner) === 0n) throw new SetupError("RELAY_ROOT_OWNER must be an address");
  const signerKey = privateKey(env.MULTIBAAS_SIGNER_PRIVATE_KEY, "MULTIBAAS_SIGNER_PRIVATE_KEY");
  const funder = privateKeyToAccount(funderKey).address;
  if (signerKey && isAddressEqual(privateKeyToAccount(signerKey).address, funder)) {
    throw new SetupError("MULTIBAAS_SIGNER_PRIVATE_KEY must not be the funder's key: the relay signer is a dedicated wallet");
  }
  if (signerKey && isAddressEqual(getAddress(owner), privateKeyToAccount(signerKey).address)) {
    throw new SetupError("RELAY_ROOT_OWNER must not be the relay signer");
  }
  const ownerKeys = [privateKey(env.VAULT_OWNER_PRIVATE_KEY, "VAULT_OWNER_PRIVATE_KEY"), privateKey(env.ADMIN_PRIVATE_KEY, "ADMIN_PRIVATE_KEY")].filter(
    (k): k is Hex => !!k,
  );
  return { mbUrl, mbKey, funderKey, rootOwner: getAddress(owner), signerKey, ownerKeys, dataDir: env.RELAY_DATA_DIR?.trim() || ".data" };
}

/** A deterministic throwaway key for a named recipient: keccak(funderKey ‖ "relay:recipient:<name>"). */
export const recipientKey = (funderKey: Hex, name: string): Hex => keccak256(concat([funderKey, stringToHex(`relay:recipient:${name}`)]));

/** The named recipients and the outsider, derived from the funder's key (addresses only leave this function). */
export function deriveRecipients(funderKey: Hex): { recipients: Record<(typeof RECIPIENTS)[number], Address>; outsider: Address } {
  const at = (name: string) => privateKeyToAccount(recipientKey(funderKey, name)).address;
  return { recipients: { supplier: at("supplier"), contractor: at("contractor") }, outsider: at(OUTSIDER) };
}

// --- What is there ----------------------------------------------------------------------------------

/** What the script found on MultiBaas and the chain before planning. */
export type Observed = {
  funder: Address;
  signer: Address;
  rootOwner: Address;
  /** Per label: not uploaded, uploaded with the same bytecode, or with different bytecode (an error). */
  uploads: Record<Label, "missing" | "same" | "different">;
  token: null | { address: Address; owner: Address; aliased: boolean; linked: boolean };
  vault: null | {
    address: Address;
    owner: Address;
    agent: Address;
    token: Address;
    aliased: boolean;
    linked: boolean;
    paused: boolean;
    balance: bigint;
    approved: Record<string, boolean>;
  };
  signerBalance: bigint;
  /** Seed entries already sent for this vault (by SEED key). */
  seeded: Partial<Record<(typeof SEED)[number]["key"], Hex>>;
};

export type StepId =
  | `upload:${Label}`
  | "deploy:token"
  | "deploy:vault"
  | "link:token"
  | "link:vault"
  | "mint"
  | "set-agent"
  | `approve:${(typeof RECIPIENTS)[number]}`
  | `seed:${(typeof SEED)[number]["key"]}`
  | "fund-signer"
  | "fund-owner"
  | "transfer-ownership";

/** One thing to do. `gas` is a rough upper estimate for a transaction (0 = MultiBaas API only). */
export type Step = { id: StepId; what: string; gas: number; ethValue?: bigint; /** STD base units, for "mint". */ amount?: bigint };

/** Rough gas for a contract creation: base + calldata + code deposit + a few storage writes. */
export const deployGas = (bytecode: Hex) => {
  const bytes = (bytecode.length - 2) / 2;
  return 53_000 + 16 * bytes + 200 * bytes + 160_000;
};

export const GAS = {
  mint: 75_000,
  setAgent: 40_000,
  setRecipient: 50_000,
  ownerTransfer: 65_000,
  ethTransfer: 21_000,
  transferOwnership: 35_000,
} as const;

/** Why the setup can't go on, if anything (things only the vault owner could fix). */
export function blockers(o: Observed): string[] {
  const out: string[] = [];
  for (const l of LABELS) if (o.uploads[l] === "different") out.push(`${l} ${CONTRACT_VERSION} is on MultiBaas with different bytecode (bump CONTRACT_VERSION or delete it there)`);
  const v = o.vault;
  if (v) {
    const ownerIsFunder = isAddressEqual(v.owner, o.funder);
    if (o.token && !isAddressEqual(v.token, o.token.address)) out.push(`the vault at ${v.address} holds token ${v.token}, not ${o.token.address}`);
    if (!ownerIsFunder && !isAddressEqual(v.owner, o.rootOwner)) out.push(`the vault is owned by ${v.owner}, neither the funder nor RELAY_ROOT_OWNER`);
    if (!ownerIsFunder && !isAddressEqual(v.agent, o.signer)) out.push(`the vault's agent is ${v.agent}, not the relay signer ${o.signer}; the owner must call setAgent(${o.signer})`);
    if (!ownerIsFunder) {
      for (const r of RECIPIENTS) if (!v.approved[r]) out.push(`${r} is not approved on the vault; the owner must call setRecipient`);
    }
  }
  if (o.token && !isAddressEqual(o.token.owner, o.funder) && planSetup(o).some((s) => s.id === "mint")) {
    out.push(`the token is owned by ${o.token.owner}, not the funder, so the vault can't be minted its STD`);
  }
  return out;
}

/** Every step still to do, in order (the full list on a fresh setup). */
export function planSetup(o: Observed): Step[] {
  const steps: Step[] = [];
  for (const l of LABELS) if (o.uploads[l] === "missing") steps.push({ id: `upload:${l}`, what: `upload ${l} ${CONTRACT_VERSION} (ABI + bytecode) to MultiBaas`, gas: 0 });

  const t = o.token;
  const v = o.vault;
  if (!t) steps.push({ id: "deploy:token", what: `deploy ${TOKEN_META.name} (${TOKEN_META.symbol}), owner = funder`, gas: deployGas(CHAIN_ARTIFACTS["relay-token"].bytecode) });
  if (!v) {
    steps.push({
      id: "deploy:vault",
      what: `deploy the policy vault (agent = relay signer, ${VAULT_LIMITS.perTxMax} STD per payment, ${VAULT_LIMITS.periodLimit} STD per 30 days), owner = funder for now`,
      gas: deployGas(CHAIN_ARTIFACTS["relay-vault"].bytecode),
    });
  }
  if (!t || !t.aliased || !t.linked) steps.push({ id: "link:token", what: 'alias relay-token and link it (events from "latest")', gas: 0 });
  if (!v || !v.aliased || !v.linked) steps.push({ id: "link:vault", what: 'alias relay-vault and link it (events from "latest")', gas: 0 });

  const ownerIsFunder = !v || isAddressEqual(v.owner, o.funder);
  if (v && ownerIsFunder && !isAddressEqual(v.agent, o.signer)) steps.push({ id: "set-agent", what: `set the vault's agent to the relay signer ${o.signer}`, gas: GAS.setAgent });

  const seedLeft = SEED.filter((s) => !o.seeded[s.key]);
  const seedNeed = seedLeft.reduce((s, x) => s + std(x.amount), 0n);
  const balance = v?.balance ?? 0n;
  if (seedLeft.length && ownerIsFunder && balance < std(VAULT_MINT) && Object.keys(o.seeded).length === 0) {
    steps.push({ id: "mint", what: `mint ${formatStd(std(VAULT_MINT) - balance)} STD to the vault`, gas: GAS.mint, amount: std(VAULT_MINT) - balance });
  } else if (seedLeft.length && ownerIsFunder && balance < seedNeed) {
    steps.push({ id: "mint", what: `mint ${formatStd(seedNeed - balance)} STD to the vault (top-up for the seed)`, gas: GAS.mint, amount: seedNeed - balance });
  }
  if (ownerIsFunder) {
    for (const r of RECIPIENTS) if (!v?.approved[r]) steps.push({ id: `approve:${r}`, what: `approve the ${r} as a vault recipient`, gas: GAS.setRecipient });
    for (const s of seedLeft) steps.push({ id: `seed:${s.key}`, what: `seed: vault ownerTransfer ${s.what}`, gas: GAS.ownerTransfer });
  }
  if (o.signerBalance < parseEther(SIGNER_MIN_ETH)) {
    steps.push({ id: "fund-signer", what: `send ${SIGNER_FUND_ETH} Sepolia ETH to the relay signer for gas`, gas: GAS.ethTransfer, ethValue: parseEther(SIGNER_FUND_ETH) });
  }
  if (!v || !isAddressEqual(v.owner, o.rootOwner)) steps.push({ id: "transfer-ownership", what: `hand the vault to RELAY_ROOT_OWNER ${o.rootOwner}`, gas: GAS.transferOwnership });
  return steps;
}

/** The reseed: optional gas for the owner and a token top-up, then the three owner transfers again. */
export function planReseed(o: { vaultBalance: bigint; paused: boolean; ownerIsFunder: boolean; ownerBalance: bigint; tokenOwnerIsFunder: boolean }, maxFeePerGas: bigint): Step[] {
  if (o.paused) throw new SetupError("the vault is paused; unpause it before reseeding");
  const steps: Step[] = [];
  const seedGas = GAS.ownerTransfer * SEED.length;
  if (!o.ownerIsFunder && o.ownerBalance < BigInt(seedGas) * maxFeePerGas) {
    steps.push({ id: "fund-owner", what: `send ${OWNER_FUND_ETH} Sepolia ETH to the vault owner for gas`, gas: GAS.ethTransfer, ethValue: parseEther(OWNER_FUND_ETH) });
  }
  if (o.vaultBalance < SEED_TOTAL) {
    if (!o.tokenOwnerIsFunder) throw new SetupError(`the vault holds ${formatStd(o.vaultBalance)} STD, less than the ${formatStd(SEED_TOTAL)} STD the seed sends, and the funder can't mint`);
    steps.push({ id: "mint", what: `mint ${formatStd(SEED_TOTAL - o.vaultBalance)} STD to the vault (top-up for the seed)`, gas: GAS.mint, amount: SEED_TOTAL - o.vaultBalance });
  }
  for (const s of SEED) steps.push({ id: `seed:${s.key}`, what: `seed: vault ownerTransfer ${s.what}`, gas: GAS.ownerTransfer });
  return steps;
}

export const formatStd = (base: bigint) => formatUnitsTrim(base, TOKEN_META.decimals);
const formatUnitsTrim = (v: bigint, decimals: number) => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
};

/** A fee cap that survives a few blocks of base-fee growth: 2 × base fee + 2 gwei. */
export const maxFeeFor = (baseFeeWei: bigint) => baseFeeWei * 2n + 2_000_000_000n;

/** Total ETH the steps may cost (gas at `maxFeePerGas` plus ETH they send). */
export function ethNeeded(steps: Step[], maxFeePerGas: bigint): { gas: number; wei: bigint } {
  const gas = steps.reduce((s, x) => s + x.gas, 0);
  const sent = steps.reduce((s, x) => s + (x.ethValue ?? 0n), 0n);
  return { gas, wei: BigInt(gas) * maxFeePerGas + sent };
}

export const eth = (wei: bigint) => `${Number(formatEther(wei)).toFixed(5)} ETH`;

// --- Progress (a crash between broadcast and receipt never sends twice) ------------------------------

export type Progress = {
  v: 1;
  chainId: number;
  funder: Address;
  token?: Address;
  vault?: Address;
  deployBlock?: number;
  /** Finished transactions by step id. */
  done: Record<string, { hash: Hex; block: number }>;
  /** A transaction broadcast (or about to be) whose receipt hasn't been seen. */
  pending?: { step: string; hash: Hex } | null;
  /** Seed transfers per vault address (lowercase), by seed key. */
  seed: Record<string, Partial<Record<(typeof SEED)[number]["key"], Hex>>>;
  /** An unfinished --reseed run. */
  reseed?: { id: string; done: Partial<Record<string, Hex>> } | null;
};

export const progressPath = (dataDir: string) => path.resolve(dataDir, "chain-setup.json");

export function emptyProgress(chainId: number, funder: Address): Progress {
  return { v: 1, chainId, funder, done: {}, pending: null, seed: {}, reseed: null };
}

/** Reads the progress file; a fresh one when absent. A corrupt file or another funder/chain is an error (never silently reset). */
export function readProgress(file: string, chainId: number, funder: Address): Progress {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyProgress(chainId, funder);
    throw e;
  }
  let p: Progress;
  try {
    p = JSON.parse(text) as Progress;
  } catch {
    throw new SetupError(`${file} is not valid JSON; fix or remove it`);
  }
  if (!p || p.v !== 1 || typeof p.done !== "object" || typeof p.seed !== "object") throw new SetupError(`${file} is not a chain-setup progress file`);
  if (p.chainId !== chainId || !isAddress(p.funder ?? "", { strict: false }) || !isAddressEqual(p.funder, funder)) {
    throw new SetupError(`${file} belongs to another funder or chain; move it away to start over`);
  }
  return p;
}

/** Atomic write (tmp + fsync + rename, mode 0600). */
export function writeFileAtomic(file: string, text: string, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export const writeProgress = (file: string, p: Progress) => writeFileAtomic(file, `${JSON.stringify(p, null, 2)}\n`);

// --- The workspace file -------------------------------------------------------------------------------

/** org/chain.json for this setup. Seed evidence: the setup's own seed plus any reseeds (newest kept). */
export function buildWorkspace(i: {
  token: Address;
  vault: Address;
  vaultOwner: Address;
  deployBlock: number;
  signer: Address;
  recipients: Record<string, Address>;
  seedTxs: { what: string; hash: Hex }[];
}): ChainWorkspace {
  const escrow = CHAIN_ARTIFACTS[ESCROW_LABEL];
  const seen = new Set<string>();
  const txs = i.seedTxs.filter((t) => !seen.has(t.hash.toLowerCase()) && seen.add(t.hash.toLowerCase()));
  return {
    v: 1,
    network: { ...NETWORK },
    token: { address: getAddress(i.token), ...TOKEN_META },
    vault: { address: getAddress(i.vault), label: VAULT_LABEL, owner: getAddress(i.vaultOwner), deployBlock: i.deployBlock },
    signer: getAddress(i.signer),
    templates: { escrow: { label: ESCROW_LABEL, version: CONTRACT_VERSION, bytecodeHash: escrow.bytecodeHash, abiHash: escrow.abiHash, networks: ["sepolia"] } },
    recipients: Object.fromEntries(Object.entries(i.recipients).map(([k, a]) => [k, getAddress(a)])),
    monitor: { largeTransfer: LARGE_TRANSFER },
    // Keep the first seed (3 entries) and the most recent reseeds, within the loader's 64-entry cap.
    seed: { txs: txs.length > 60 ? [...txs.slice(0, SEED.length), ...txs.slice(-(60 - SEED.length))] : txs },
  };
}

export const writeWorkspace = (file: string, ws: ChainWorkspace) => writeFileAtomic(file, serializeChainWorkspace(ws), 0o644);
