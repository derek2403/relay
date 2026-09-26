// The whole Keyless Relay story on a local anvil fork of Sepolia, with
// assertions: `npm run demo:fork`.
//
// Builds a company tree with the real ENSv2 contracts (a .eth root -> eng ->
// derek -> agent session started through SessionMinter), then calls the
// relay's own route handlers in-process against it and checks every rule:
// caps at every level (also under concurrent calls), count limits, provider lists, owner
// checks, revocation cascade, session expiry, the canonical-name and
// genuine-registry/resolver checks, the pinned root owner, token revocation
// (relay.nbf), the GitHub filter and who may read the log.
// Finally it runs the agent CLI (scripts/agent.ts) against the same relay
// over HTTP.
//
// Uses anvil on 127.0.0.1:8602 if one is already running there, otherwise
// starts one (ANVIL_BIN, ~/.foundry/bin/anvil or anvil on PATH) and stops it
// at the end. Every run registers a fresh root label, so it can be re-run
// against the same fork. FORK_URL overrides the Sepolia RPC it forks from.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import {
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  type LocalAccount,
  type TransactionReceipt,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http as viemHttp,
  isAddressEqual,
  keccak256,
  parseEther,
  toHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import * as relayRoute from "@/app/api/relay/[provider]/[[...path]]/route";
import * as adminRoute from "@/app/api/relay/admin/route";
import * as logRoute from "@/app/api/relay/log/route";
import * as policyRoute from "@/app/api/relay/policy/route";
import * as statusRoute from "@/app/api/relay/status/route";
import { ETHRegistrarAbi } from "@/lib/ens/abis/ETHRegistrar";
import { ETHRegistryAbi } from "@/lib/ens/abis/ETHRegistry";
import { MockUSDCAbi } from "@/lib/ens/abis/MockUSDC";
import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { ENSV2_SEPOLIA } from "@/lib/ens/deployments";
import { formatError } from "@/lib/ens/errors";
import {
  PERMISSIONED_RESOLVER_IMPL,
  USER_REGISTRY_IMPL,
  VERIFIABLE_FACTORY,
  allRolesTo,
  encodeRegistryInit,
  encodeResolverInit,
  predictProxyAddress,
  proxyAddressFromLogs,
  registrySalt,
  resolverSalt,
  verifiableFactoryAbi,
} from "@/lib/ens/factory";
import { dnsEncode, labelId, namehash } from "@/lib/ens/names";
import { TOKEN_NBF_KEY } from "@/lib/relay/ens";
import { RegistryRoles, ResolverRoles } from "@/lib/ens/roles";
import { bundleCalls, encodeSetText } from "@/lib/relay/browser";
import { type Bundle, RECORD_KEYS } from "@/lib/relay/bundle";
import { DEFAULT_RPC_URL } from "@/lib/relay/config";
import { getMeter } from "@/lib/relay/meter";
import { SessionMinterAbi, SessionMinterBytecode } from "@/lib/relay/sessionMinter";
import { createToken, verifyToken } from "@/lib/relay/token";
import type { LogEntry, PolicyResponse } from "@/lib/relay/types";

const PORT = Number(process.env.FORK_PORT || 8602);
const RPC = `http://127.0.0.1:${PORT}`;
const FORK_URL = process.env.FORK_URL || DEFAULT_RPC_URL;
const REPO = process.cwd();
const CLI = path.join(REPO, "scripts", "agent.ts");
const MNEMONIC = "test test test test test test test test test test test junk";

const DAY = 86_400n;
const HOUR = 3_600n;

const ETH_REGISTRY = ENSV2_SEPOLIA.ETHRegistry.address;
const REGISTRAR = ENSV2_SEPOLIA.ETHRegistrar.address;
const USDC = ENSV2_SEPOLIA.MockUSDC.address;
const PUBLIC_RESOLVER_V2 = ENSV2_SEPOLIA.PublicResolverV2.address;

// --- Log and assertions ----------------------------------------------------------

let checks = 0;
let failures = 0;

const section = (title: string) => console.log(`\n${title}`);
const done = (msg: string) => console.log(`  ✓ ${msg}`);
const note = (msg: string) => console.log(`    ${msg}`);

function expect(ok: boolean, msg: string, detail?: string) {
  checks++;
  if (ok) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}${detail ? `\n      got: ${detail}` : ""}`);
  }
}

const near = (a: number | undefined, b: number) => Math.abs((a ?? 0) - b) < 1e-9;

// --- Anvil ----------------------------------------------------------------------------

async function rpcChainId(): Promise<string | null> {
  try {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    return ((await res.json()) as { result?: string }).result ?? null;
  } catch {
    return null;
  }
}

function findAnvil(): string | null {
  const candidates = [process.env.ANVIL_BIN, path.join(os.homedir(), ".foundry", "bin", "anvil")];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, "anvil"));
  return candidates.find((c): c is string => !!c && fs.existsSync(c)) ?? null;
}

async function ensureAnvil(): Promise<ChildProcess | null> {
  const existing = await rpcChainId();
  if (existing) {
    if (Number(existing) !== sepolia.id) throw new Error(`Port ${PORT} is serving chain ${Number(existing)}, not a Sepolia fork.`);
    done(`using the anvil fork already running on ${RPC}`);
    return null;
  }
  const bin = findAnvil();
  if (!bin) {
    throw new Error(
      `No anvil found. Install Foundry (https://getfoundry.sh), set ANVIL_BIN, or start one yourself:\n    anvil --fork-url ${FORK_URL} --port ${PORT}`,
    );
  }
  // ANVIL_LOG=<file> keeps anvil's own log (for debugging a stuck run).
  const logFile = process.env.ANVIL_LOG;
  const child = spawn(bin, ["--fork-url", FORK_URL, "--port", String(PORT), ...(logFile ? [] : ["--silent"])], {
    stdio: ["ignore", logFile ? fs.openSync(logFile, "w") : "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`anvil exited (${child.exitCode}): ${stderr.trim().slice(0, 500)}`);
    if (await rpcChainId()) {
      done(`started anvil forking ${FORK_URL} on ${RPC}`);
      return child;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill("SIGTERM");
  throw new Error("anvil did not start within 60 s");
}

// --- Chain helpers ----------------------------------------------------------------------

const transport = viemHttp(RPC, { timeout: 120_000 });
const pub = createPublicClient({ chain: sepolia, transport, pollingInterval: 50 });
const test = createTestClient({ chain: sepolia, transport, mode: "anvil", pollingInterval: 50 });

type Actor = { label: string; account: LocalAccount; wallet: ReturnType<typeof createWalletClient> };

const actor = (label: string, account: LocalAccount): Actor => ({
  label,
  account,
  wallet: createWalletClient({ account, chain: sepolia, transport, pollingInterval: 50 }),
});

const devAccount = (index: number) => mnemonicToAccount(MNEMONIC, { addressIndex: index });

/**
 * Polls for a receipt. viem's waitForTransactionReceipt can miss an automined transaction (its first
 * lookup races the mining, then it waits for a newer block that never comes) and hang until timeout.
 */
async function receiptOf(hash: Hex): Promise<TransactionReceipt> {
  for (let i = 0; i < 600; i++) {
    const receipt = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`transaction ${hash} was not mined within 60 s`);
}

type Writable = "nonpayable" | "payable";

/** Simulates (for readable revert reasons), sends and waits for one transaction. */
async function write<const A extends Abi, F extends ContractFunctionName<A, Writable>>(
  who: Actor,
  address: Address,
  abi: A,
  functionName: F,
  args: ContractFunctionArgs<A, Writable, F>,
): Promise<TransactionReceipt> {
  let hash: Hex;
  try {
    const { request } = await pub.simulateContract({ account: who.account, address, abi, functionName, args } as never);
    hash = await who.wallet.writeContract(request as never);
  } catch (err) {
    throw new Error(`${who.label}: ${functionName} failed: ${formatError(err)}`);
  }
  const receipt = await receiptOf(hash);
  if (receipt.status !== "success") throw new Error(`${who.label}: ${functionName} reverted (${hash})`);
  return receipt;
}

const chainNow = async () => (await pub.getBlock({ blockTag: "latest" })).timestamp;

async function timeTravel(seconds: bigint) {
  await test.increaseTime({ seconds: Number(seconds) });
  await test.mine({ blocks: 1 });
}

async function deployProxy(who: Actor, impl: Address, salt: bigint, data: Hex): Promise<Address> {
  const receipt = await write(who, VERIFIABLE_FACTORY, verifiableFactoryAbi, "deployProxy", [impl, salt, data]);
  const proxy = proxyAddressFromLogs(receipt.logs);
  if (!proxy) throw new Error(`${who.label}: deployProxy emitted no ProxyDeployed event`);
  return proxy;
}

/** The account's own PermissionedResolver (one per account, salt version 0); reused if an earlier run deployed it. */
async function ensureResolver(who: Actor): Promise<Address> {
  const proxyLogic = await pub.readContract({ address: VERIFIABLE_FACTORY, abi: verifiableFactoryAbi, functionName: "proxyLogic" });
  const salt = resolverSalt(who.account.address);
  const predicted = predictProxyAddress({ proxyLogic, deployer: who.account.address, salt });
  const code = await pub.getCode({ address: predicted });
  if (code && code !== "0x") return predicted;
  return deployProxy(who, PERMISSIONED_RESOLVER_IMPL, salt, encodeResolverInit(allRolesTo(who.account.address)));
}

/** Deploys `name`'s own UserRegistry, attaches it on the owner's entry in the parent registry and sets the parent pointer. */
async function attachRegistry(who: Actor, name: string, parentRegistry: Address, label: string, viaEthRegistry = false): Promise<Address> {
  const registry = await deployProxy(who, USER_REGISTRY_IMPL, registrySalt(namehash(name)), encodeRegistryInit(allRolesTo(who.account.address)));
  if (viaEthRegistry) await write(who, ETH_REGISTRY, ETHRegistryAbi, "setSubregistry", [labelId(label), registry]);
  else await write(who, parentRegistry, UserRegistryImplAbi, "setSubregistry", [labelId(label), registry]);
  await write(who, registry, UserRegistryImplAbi, "setParent", [parentRegistry, label]);
  return registry;
}

const writeBundle = (who: Actor, resolver: Address, name: string, bundle: Bundle) =>
  write(who, resolver, PermissionedResolverImplAbi, "multicall", [bundleCalls(name, bundle)]);

// --- Relay (in-process route handlers) -----------------------------------------------------

type RelayResult = { status: number; reason: string | null; json: Record<string, unknown> | null };

const nowSec = () => Math.floor(Date.now() / 1000);
const tokenFor = (signer: LocalAccount, name: string) => createToken(signer, { name, iat: nowSec(), exp: nowSec() + 3600 });

/** Sent by the in-process calls to /policy and /log (RELAY_ADMIN_TOKEN is set for this run). */
const ADMIN_TOKEN = `demo-admin-${Date.now().toString(36)}`;
const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function relayCall(provider: string, token: string, opts: { method?: string; path?: string; body?: unknown } = {}): Promise<RelayResult> {
  const get = provider === "github" && !opts.method;
  const method = opts.method ?? (get ? "GET" : "POST");
  const subpath = opts.path ?? (get ? "/user" : "/v1/messages");
  const body = method === "GET" ? undefined : JSON.stringify(opts.body ?? { model: "mock", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
  const request = new NextRequest(`http://localhost:3000/api/relay/${provider}${subpath}`, {
    method,
    headers: provider === "github" ? { authorization: `Bearer ${token}` } : { "x-api-key": token, "content-type": "application/json" },
    body,
  });
  const handler = relayRoute[method as "GET" | "POST"];
  const res = await handler(request, { params: Promise.resolve({ provider, path: subpath.split("/").filter(Boolean) }) });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, reason: typeof json?.reason === "string" ? json.reason : null, json };
}

async function policy(name: string, provider: string | null = "mock"): Promise<PolicyResponse> {
  const q = new URLSearchParams({ name });
  if (provider) q.set("provider", provider);
  const res = await policyRoute.GET(new NextRequest(`http://localhost:3000/api/relay/policy?${q}`, { headers: asAdmin }));
  if (res.status !== 200) throw new Error(`policy endpoint answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as PolicyResponse;
}

async function recentLog(limit: number, headers: Record<string, string> = asAdmin): Promise<{ status: number; entries: LogEntry[] }> {
  const res = await logRoute.GET(new NextRequest(`http://localhost:3000/api/relay/log?limit=${limit}`, { headers }));
  const body = await res.json();
  return { status: res.status, entries: Array.isArray(body) ? (body as LogEntry[]) : [] };
}

const mockSpend = (p: PolicyResponse) => p.levels.map((l) => l.spent.mock ?? 0);
const describeSpend = (p: PolicyResponse) => p.levels.map((l) => `${l.name.split(".")[0]} $${+(l.spent.mock ?? 0).toFixed(6)}`).join(", ");

/** Serves the same route handlers over HTTP, so the CLI can run as a separate process against this fork. */
function startHttpRelay(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      }
      const method = (req.method ?? "GET").toUpperCase();
      const body = method === "GET" || method === "HEAD" || !chunks.length ? undefined : new Uint8Array(Buffer.concat(chunks));
      const request = new NextRequest(`http://${req.headers.host}${req.url}`, { method, headers, body });

      let response: Response;
      const relay = url.pathname.match(/^\/api\/relay\/([^/]+)(\/.*)?$/);
      if (url.pathname === "/api/relay/policy") response = await policyRoute.GET(request);
      else if (url.pathname === "/api/relay/log") response = await logRoute.GET(request);
      else if (url.pathname === "/api/relay/status") response = await statusRoute.GET();
      else if (relay && method in relayRoute) {
        const handler = relayRoute[method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"];
        response = await handler(request, { params: Promise.resolve({ provider: relay[1], path: relay[2]?.split("/").filter(Boolean) }) });
      } else response = Response.json({ error: "not found" }, { status: 404 });

      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "demo server error", reason: err instanceof Error ? err.message : String(err) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}/api/relay`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

type CliResult = { code: number; stdout: string; stderr: string; combined: string };

/** Runs the agent CLI as its own process (async, so this process can keep serving the relay). */
function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "", combined: "" };
    child.stdout.on("data", (d) => ((out.stdout += String(d)), (out.combined += String(d))));
    child.stderr.on("data", (d) => ((out.stderr += String(d)), (out.combined += String(d))));
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, ...out });
    });
  });
}

const cliShow = (r: CliResult) =>
  r.combined
    .trim()
    .split("\n")
    .map((l) => `      | ${l}`)
    .join("\n");

// --- The story ---------------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(CLI)) throw new Error("Run this from the repo root: npm run demo:fork");
  console.log("Keyless Relay: end-to-end demo on an anvil fork of Sepolia");
  const anvil = await ensureAnvil();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keyless-demo-"));
  let httpRelay: { base: string; close: () => Promise<void> } | null = null;
  let completed = false;

  try {
    // The relay reads the fork. Provider keys are cleared so nothing real is ever called; github gets a
    // dummy key and a dead upstream so its calls reach the policy check (and would fail if allowed).
    const rootLabel = `kr${Date.now().toString(36)}`;
    const root = `${rootLabel}.eth`;
    // The root owner is pinned (RELAY_ROOT_OWNER) and the log needs the admin token.
    Object.assign(process.env, {
      RELAY_RPC_URL: RPC,
      RELAY_ROOT_NAME: root,
      RELAY_ROOT_OWNER: devAccount(0).address,
      RELAY_ADMIN_TOKEN: ADMIN_TOKEN,
      RELAY_DATA_DIR: path.join(tmp, "data"),
      RELAY_REQUIRE_CANONICAL: "true",
      RELAY_PUBLIC_URL: "http://localhost:3000",
      GITHUB_TOKEN: "demo-token-not-real",
      RELAY_UPSTREAM_GITHUB: "http://127.0.0.1:9",
    });
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RAILWAY_TOKEN", "RELAY_DNS_ALIAS", "RELAY_UPSTREAM_CLAUDE", "RELAY_UPSTREAM_CODEX"]) {
      delete process.env[key];
    }

    // Anvil's well-known dev accounts carry EIP-7702 delegation code on Sepolia, which rejects the
    // ERC1155 mint callback ENSv2 registries make. Clearing the code on the fork makes them plain EOAs.
    const acme = actor("acme", devAccount(0));
    const eng = actor("eng", devAccount(1));
    const derek = actor("derek", devAccount(2));
    const derek2 = actor("derek2", devAccount(3));
    const outsider = actor("outsider", devAccount(4));
    for (const a of [acme, eng, derek, derek2, outsider]) {
      await test.setCode({ address: a.account.address, bytecode: "0x" });
      await test.setBalance({ address: a.account.address, value: parseEther("100") });
    }
    done(`dev accounts ready: acme #0, eng #1, derek #2, derek2 #3, outsider #4`);

    // A fresh agent key, made by the CLI the way an agent would.
    const keyFile = path.join(tmp, "agent.json");
    const created = await runCli(["new", "--key", keyFile], {});
    if (created.code !== 0) throw new Error(`agent new failed:\n${cliShow(created)}`);
    const agentKey = JSON.parse(fs.readFileSync(keyFile, "utf8")) as { privateKey: Hex; address: Address };
    const agent = privateKeyToAccount(agentKey.privateKey);
    expect(created.stdout.trim() === agent.address && (fs.statSync(keyFile).mode & 0o777) === 0o600, `agent new created key ${agent.address} (mode 600)`);

    // 1. Root name ---------------------------------------------------------------------------
    section(`1. acme registers ${root}`);
    const minDuration = await pub.readContract({ address: REGISTRAR, abi: ETHRegistrarAbi, functionName: "MIN_REGISTER_DURATION" });
    const duration = 365n * DAY > minDuration ? 365n * DAY : minDuration;
    const [base, premium] = await pub.readContract({ address: REGISTRAR, abi: ETHRegistrarAbi, functionName: "getRegisterPrice", args: [rootLabel, duration, USDC] });
    await write(acme, USDC, MockUSDCAbi, "mint", [acme.account.address, base + premium]);
    await write(acme, USDC, MockUSDCAbi, "approve", [REGISTRAR, base + premium]);
    done(`minted ${Number(base + premium) / 1e6} MockUSDC and approved the ETHRegistrar`);
    const secret = keccak256(toHex(`keyless-demo-${rootLabel}`));
    const commitment = await pub.readContract({
      address: REGISTRAR,
      abi: ETHRegistrarAbi,
      functionName: "makeCommitment",
      args: [rootLabel, acme.account.address, secret, zeroAddress, zeroAddress, duration, zeroHash],
    });
    await write(acme, REGISTRAR, ETHRegistrarAbi, "commit", [commitment]);
    await timeTravel(61n);
    await write(acme, REGISTRAR, ETHRegistrarAbi, "register", [rootLabel, acme.account.address, secret, zeroAddress, zeroAddress, duration, USDC, zeroHash]);
    done(`committed, skipped 61 s (evm_increaseTime), registered ${root} for ${duration / DAY} days`);

    // 2. Root's resolver, registry and bundle ------------------------------------------------------
    section("2. acme sets up the company root");
    const rAcme = await ensureResolver(acme);
    await write(acme, ETH_REGISTRY, ETHRegistryAbi, "setResolver", [labelId(rootLabel), rAcme]);
    const gRoot = await attachRegistry(acme, root, ETH_REGISTRY, rootLabel, true);
    done(`resolver ${rAcme}, subname registry ${gRoot} (setSubregistry + setParent)`);
    await writeBundle(acme, rAcme, root, { keys: ["claude", "codex", "github", "mock"], caps: { claude: 500, codex: 500, mock: 1 }, period: "month" });
    done("root bundle: claude $500 · codex $500 · github · mock $1 / month");

    // 3. Member eng --------------------------------------------------------------------------------
    const engName = `eng.${root}`;
    section(`3. acme adds ${engName}`);
    let t = await chainNow();
    await write(acme, gRoot, UserRegistryImplAbi, "register", ["eng", eng.account.address, zeroAddress, rAcme, RegistryRoles.ROLE_SET_SUBREGISTRY, t + 30n * DAY]);
    await writeBundle(acme, rAcme, engName, { keys: ["claude", "codex", "github", "mock"], caps: { claude: 100, codex: 100, mock: 0.5 }, period: "month" });
    done("registered eng (owner eng, ROLE_SET_SUBREGISTRY only) with its bundle on acme's resolver: mock $0.50 / month");
    const rEng = await ensureResolver(eng);
    const gEng = await attachRegistry(eng, engName, gRoot, "eng");
    done(`eng deployed resolver ${rEng} and registry ${gEng} and attached it`);

    // 4. Member derek ------------------------------------------------------------------------------
    const derekName = `derek.${engName}`;
    section(`4. eng adds ${derekName}`);
    t = await chainNow();
    await write(eng, gEng, UserRegistryImplAbi, "register", ["derek", derek.account.address, zeroAddress, rEng, RegistryRoles.ROLE_SET_SUBREGISTRY, t + 30n * DAY]);
    const derekBundle: Bundle = { keys: ["claude", "github", "mock"], caps: { claude: 20, mock: 0.2 }, period: "month" };
    await writeBundle(eng, rEng, derekName, derekBundle);
    done("registered derek with its bundle on eng's resolver: claude $20 · github · mock $0.20 / month");
    const rDerek = await ensureResolver(derek);
    const gDerek = await attachRegistry(derek, derekName, gEng, "derek");
    done(`derek deployed resolver ${rDerek} and registry ${gDerek} (names below derek are enabled)`);

    // 5. Agent session through SessionMinter -----------------------------------------------------------
    const laptop = `laptop.${derekName}`;
    section(`5. derek starts an agent session ${laptop} in one transaction`);
    const deployHash = await derek.wallet.deployContract({ abi: SessionMinterAbi, bytecode: SessionMinterBytecode, account: derek.account, chain: sepolia });
    const minter = (await receiptOf(deployHash)).contractAddress!;
    await write(derek, gDerek, UserRegistryImplAbi, "grantRootRoles", [RegistryRoles.ROLE_REGISTRAR, minter]);
    await write(derek, rDerek, PermissionedResolverImplAbi, "grantRootRoles", [ResolverRoles.ROLE_SET_TEXT | ResolverRoles.ROLE_SET_ADDRESS, minter]);
    done(`SessionMinter ${minter} deployed and enabled (ROLE_REGISTRAR on derek's registry, SET_TEXT|SET_ADDRESS on derek's resolver)`);

    const startSession = async (label: string, hours: bigint, bundle: Bundle) => {
      const expiry = (await chainNow()) + hours * HOUR;
      const name = `${label}.${derekName}`;
      const receipt = await write(derek, minter, SessionMinterAbi, "startSession", [gDerek, rDerek, label, agent.address, expiry, bundleCalls(name, bundle, { agent: agent.address })]);
      return { name, expiry, receipt };
    };
    const s1 = await startSession("laptop", 2n, { keys: ["mock", "claude"], caps: { mock: 0.03, claude: 10 }, period: "total" });
    const s1State = await pub.readContract({ address: gDerek, abi: UserRegistryImplAbi, functionName: "getState", args: [labelId("laptop")] });
    const s1Roles = await pub.readContract({ address: gDerek, abi: UserRegistryImplAbi, functionName: "roles", args: [s1State.resource, agent.address] });
    expect(
      s1State.status === 2 && isAddressEqual(s1State.latestOwner, agent.address) && s1State.expiry === s1.expiry && s1Roles === 0n,
      `startSession registered laptop to the agent key with no roles, expiring in 2 h (gas ${s1.receipt.gasUsed})`,
    );
    note("bundle: mock $0.03 · claude $10 / total (no github), plus addr(laptop) = agent key");

    // 6. Relay checks -------------------------------------------------------------------------------------
    section("6. The relay, pointed at the fork");
    const agentToken = await tokenFor(agent, laptop);

    console.log("  (a) three mock calls");
    for (let i = 1; i <= 3; i++) {
      const r = await relayCall("mock", agentToken);
      expect(r.status === 200, `call ${i} → ${r.status}`, JSON.stringify(r.json));
    }
    const charged = (await recentLog(3)).entries.filter((e) => e.allowed && e.provider === "mock");
    expect(charged.length === 3 && charged.every((e) => e.costUsd === 0.01 && !e.estimated), "each call was logged at exactly $0.01");
    let p = await policy(laptop);
    expect(mockSpend(p).length === 4 && mockSpend(p).every((s) => near(s, 0.03)), `every level was charged: ${describeSpend(p)}`);

    console.log("  (b) the cap");
    let r = await relayCall("mock", agentToken);
    expect(r.status === 403 && /laptop\..* has used its mock cap \(\$0\.03\)/.test(r.reason ?? ""), `4th call refused (${r.status}): ${r.reason}`);

    console.log("  (c) a provider the session doesn't list");
    r = await relayCall("github", agentToken);
    expect(r.status === 403 && /laptop\..* does not allow github/.test(r.reason ?? ""), `github refused (${r.status}): ${r.reason}`);
    r = await relayCall("github", await tokenFor(derek.account, derekName), { method: "POST", path: "/user/keys", body: { key: "ssh-ed25519 AAAA" } });
    expect(r.status === 403 && /credentials or change who has access/.test(r.reason ?? ""), `derek (github allowed) adding an SSH key is refused by the filter (${r.status})`);

    console.log("  (d) someone else's key");
    r = await relayCall("mock", await tokenFor(outsider.account, laptop));
    expect(r.status === 401 && /does not own/.test(r.reason ?? ""), `token for laptop signed by the outsider refused (${r.status}): ${r.reason}`);

    console.log("  (e) a name outside the company");
    r = await relayCall("mock", await tokenFor(agent, "laptop.nick.eth"));
    expect(r.status === 403 && /is not under/.test(r.reason ?? ""), `token for laptop.nick.eth refused (${r.status}): ${r.reason}`);

    console.log("  (f) the policy endpoint");
    p = await policy(laptop);
    expect(
      p.levels.map((l) => l.name).join() === [root, engName, derekName, laptop].join() && p.levels.every((l) => l.status === "registered" && l.bundle),
      `lists 4 levels with bundles: ${p.levels.map((l) => l.name.split(".")[0]).join(" → ")}`,
    );
    expect(
      p.levels.slice(1).every((l) => l.checks.registryVerified && l.checks.resolverVerified && l.checks.canonical) && p.levels[0].checks.resolverVerified === true,
      "every level's registry and resolver are genuine and canonical",
    );
    expect(p.allowed === false && p.levels[3].bundle?.caps.mock === 0.03, `and says mock is now refused: ${p.reason}`);

    console.log("  (g) a child can't raise its own ceiling");
    await write(derek, rDerek, PermissionedResolverImplAbi, "setText", [dnsEncode(laptop), RECORD_KEYS.cap("mock"), "1000"]);
    await write(acme, rAcme, PermissionedResolverImplAbi, "multicall", [[encodeSetText(engName, RECORD_KEYS.cap("mock"), "0.05")]]);
    done("derek raised laptop's mock cap to $1000; acme set eng's mock cap to $0.05 (eng has spent $0.03)");
    for (let i = 1; i <= 2; i++) {
      r = await relayCall("mock", agentToken);
      expect(r.status === 200, `call → ${r.status} (eng at $${(0.03 + i * 0.01).toFixed(2)})`, r.reason ?? undefined);
    }
    r = await relayCall("mock", agentToken);
    expect(r.status === 403 && /^eng\..* has used its mock cap \(\$0\.05\)/.test(r.reason ?? ""), `next call refused by the parent (${r.status}): ${r.reason}`);
    p = await policy(laptop);
    expect(p.levels[3].bundle?.caps.mock === 1000 && near(p.levels[1].spent.mock, 0.05), `laptop's own cap reads $1000, eng spent ${p.levels[1].spent.mock}`);
    await write(acme, rAcme, PermissionedResolverImplAbi, "multicall", [[encodeSetText(engName, RECORD_KEYS.cap("mock"), "1")]]);
    done("acme put eng's mock cap back to $1");

    console.log("  (g2) concurrent calls can't overrun a cap");
    const burst = await startSession("burst", 1n, { keys: ["mock"], caps: { mock: 0.05 }, period: "total" });
    const burstToken = await tokenFor(agent, burst.name);
    const results = await Promise.all(Array.from({ length: 10 }, () => relayCall("mock", burstToken)));
    const okCount = results.filter((x) => x.status === 200).length;
    p = await policy(burst.name);
    expect(okCount === 5 && near(p.levels[3].spent.mock, 0.05), `10 calls at once against a $0.05 cap: ${okCount} allowed, burst spent ${p.levels[3].spent.mock}`);

    console.log("  (g2b) count limits (relay.max.<api>)");
    const counted = await startSession("counted", 1n, { keys: ["mock"], caps: {}, maxes: { mock: 2 }, period: "total" });
    const countedResults = await Promise.all(Array.from({ length: 5 }, async () => relayCall("mock", await tokenFor(agent, counted.name))));
    const countedOk = countedResults.filter((x) => x.status === 200).length;
    const countRefusal = countedResults.find((x) => x.status === 403)?.reason ?? "";
    p = await policy(counted.name);
    expect(
      countedOk === 2 && /^counted\..* has used its mock limit \(2 requests\)/.test(countRefusal) && p.levels[3].used?.mock === 2 && (p.levels[2].used?.mock ?? 0) >= 2,
      `5 calls at once against a 2-request limit: ${countedOk} allowed, counted used ${p.levels[3].used?.mock}, derek used ${p.levels[2].used?.mock}; refused: ${countRefusal}`,
    );

    console.log("  (g3) who may read the log");
    let seen = await recentLog(50, {});
    expect(seen.status === 401, `no credentials: ${seen.status}`);
    seen = await recentLog(50, { "x-api-key": burstToken });
    expect(seen.status === 200 && seen.entries.length > 0 && seen.entries.every((e) => e.name === burst.name), `the burst agent's token sees only its own ${seen.entries.length} entries`);
    const other = await policyRoute.GET(new NextRequest(`http://localhost:3000/api/relay/policy?name=${laptop}`, { headers: { "x-api-key": burstToken } }));
    expect(other.status === 403, `and can't read another session's policy (${other.status})`);
    const signIn = await adminRoute.POST(
      new NextRequest("http://localhost:3000/api/relay/admin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${ADMIN_TOKEN}` }),
    );
    const cookie = signIn.headers.get("set-cookie")?.split(";")[0] ?? "";
    seen = await recentLog(50, { cookie });
    expect(signIn.status === 303 && seen.status === 200 && seen.entries.some((e) => e.name === laptop), "signing in at /api/relay/admin sets a cookie that reads the whole log");

    console.log("  (g4) the root must still belong to RELAY_ROOT_OWNER");
    process.env.RELAY_ROOT_OWNER = outsider.account.address;
    r = await relayCall("mock", burstToken);
    expect(r.status === 503 && /RELAY_ROOT_OWNER/.test(r.reason ?? ""), `pinned to someone else: refused (${r.status})`);
    process.env.RELAY_ROOT_OWNER = acme.account.address;

    console.log("  (h) removing a member cuts off everything below it");
    await write(eng, gEng, UserRegistryImplAbi, "unregister", [labelId("derek")]);
    r = await relayCall("mock", agentToken);
    expect(
      r.status === 403 && r.json?.error === "access revoked" && /^access revoked: derek\..* was removed or expired\. Run \.\/relay login\.$/.test(r.reason ?? ""),
      `eng unregistered derek; laptop refused on the next request (${r.status}): ${r.reason}`,
    );
    p = await policy(laptop);
    expect(p.levels[2].status === "available" && p.levels[3].status === "missing", `derek is ${p.levels[2].status}, laptop is ${p.levels[3].status}`);

    console.log("  (i) a session ends on its own");
    t = await chainNow();
    await write(eng, gEng, UserRegistryImplAbi, "register", ["derek", derek.account.address, zeroAddress, rEng, RegistryRoles.ROLE_SET_SUBREGISTRY, t + 30n * DAY]);
    await write(derek, gEng, UserRegistryImplAbi, "setSubregistry", [labelId("derek"), gDerek]);
    done("eng re-registered derek; derek re-attached its registry");
    p = await policy(derekName);
    expect(near(p.levels[2].spent.mock, 0), `re-registered derek starts at $0 (new resource ${p.levels[2].resource?.slice(0, 12)}…)`);
    const s2 = await startSession("laptop2", 1n, { keys: ["mock"], caps: { mock: 0.05 }, period: "total" });
    const token2 = await tokenFor(agent, s2.name);
    r = await relayCall("mock", token2);
    expect(r.status === 200, `new 1 h session laptop2 works (${r.status})`, r.reason ?? undefined);
    await timeTravel(HOUR + 120n);
    r = await relayCall("mock", token2);
    expect(
      r.status === 403 && /^access revoked: laptop2\..* was removed or expired/.test(r.reason ?? ""),
      `1 h later, with no transaction, laptop2 is refused (${r.status}): ${r.reason}`,
    );

    console.log("  (j) aliasing through someone else's registry");
    t = await chainNow();
    await write(eng, gEng, UserRegistryImplAbi, "register", ["derek2", derek2.account.address, zeroAddress, rEng, RegistryRoles.ROLE_SET_SUBREGISTRY, t + 30n * DAY]);
    await writeBundle(eng, rEng, `derek2.${engName}`, { keys: ["claude", "mock"], caps: { mock: 5 }, period: "month" });
    await write(derek2, gEng, UserRegistryImplAbi, "setSubregistry", [labelId("derek2"), gEng]);
    done("eng added derek2; derek2 pointed its subregistry at eng's registry");
    const s3 = await startSession("laptop3", 4n, { keys: ["mock", "claude"], caps: { mock: 1, claude: 10 }, period: "total" });
    const token3 = await tokenFor(agent, s3.name);
    r = await relayCall("mock", token3);
    expect(r.status === 200, `new session laptop3 works on its real path (${r.status})`, r.reason ?? undefined);
    const aliased = `laptop3.derek.derek2.${engName}`;
    p = await policy(aliased);
    const aliasLevel = p.levels.find((l) => l.name === `derek.derek2.${engName}`);
    expect(
      p.levels.length === 5 && aliasLevel?.status === "registered" && aliasLevel.checks.canonical === false && !!p.levels[4].owner && isAddressEqual(p.levels[4].owner, agent.address),
      `${aliased} reaches laptop3 (owner = agent), but the registry it passes through is eng's, which points back to eng, not derek2 (canonical: false)`,
    );
    r = await relayCall("mock", await tokenFor(agent, aliased));
    expect(r.status === 403 && /not canonical/.test(r.reason ?? ""), `call through the aliased path refused (${r.status}): ${r.reason}`);
    await write(derek2, gEng, UserRegistryImplAbi, "setSubregistry", [labelId("derek2"), ETH_REGISTRY]);
    const viaEth = `${rootLabel}.derek2.${engName}`;
    p = await policy(viaEth);
    const ethLevel = p.levels.find((l) => l.name === viaEth);
    expect(
      !!ethLevel && ethLevel.status === "registered" && ethLevel.checks.registryVerified === false && /not a genuine ENSv2 UserRegistry/.test(p.reason ?? ""),
      `derek2 pointed its subregistry at ETHRegistry: ${viaEth} reaches ${root} but is refused (registry not genuine)`,
    );

    console.log("  (k) only genuine PermissionedResolvers are trusted");
    await write(derek, gDerek, UserRegistryImplAbi, "setResolver", [labelId("laptop3"), PUBLIC_RESOLVER_V2]);
    r = await relayCall("mock", token3);
    expect(r.status === 403 && /resolver for laptop3\..* is not a genuine ENSv2 PermissionedResolver/.test(r.reason ?? ""), `resolver set to PublicResolverV2: refused (${r.status}): ${r.reason}`);
    await write(derek, gDerek, UserRegistryImplAbi, "setResolver", [labelId("laptop3"), outsider.account.address]);
    r = await relayCall("mock", token3);
    expect(r.status === 403 && /not a genuine ENSv2 PermissionedResolver/.test(r.reason ?? ""), `resolver set to an EOA: refused (${r.status})`);
    await write(derek, gDerek, UserRegistryImplAbi, "setResolver", [labelId("laptop3"), rDerek]);
    r = await relayCall("mock", token3);
    expect(r.status === 200, `resolver set back to derek's PermissionedResolver: allowed again (${r.status})`, r.reason ?? undefined);

    console.log("  (l) revoking old tokens without removing the name");
    await new Promise((res) => setTimeout(res, 1100));
    await write(derek, rDerek, PermissionedResolverImplAbi, "setText", [dnsEncode(s3.name), TOKEN_NBF_KEY, String(nowSec())]);
    r = await relayCall("mock", token3);
    expect(r.status === 401 && /relay\.nbf/.test(r.reason ?? ""), `derek set relay.nbf on laptop3: the earlier token is refused (${r.status})`);
    r = await relayCall("mock", await tokenFor(agent, s3.name));
    expect(r.status === 200, `a token signed after it works (${r.status})`, r.reason ?? undefined);

    // 7. The agent CLI over HTTP --------------------------------------------------------------------------------
    section("7. The agent CLI against the same relay over HTTP");
    httpRelay = await startHttpRelay();
    // The CLI binds its tokens to the relay's origin; the relay accepts its own public origin.
    process.env.RELAY_PUBLIC_URL = new URL(httpRelay.base).origin;
    const cliEnv = { RELAY_RPC_URL: RPC, KEYLESS_KEY_FILE: keyFile, KEYLESS_RELAY_URL: httpRelay.base, RELAY_DNS_ALIAS: "", KEYLESS_ADMIN_TOKEN: "" };
    note(`relay at ${httpRelay.base}`);

    const addr = await runCli(["address"], cliEnv);
    expect(addr.code === 0 && addr.stdout.trim() === agent.address, "agent address prints the key's address");

    const pol = await runCli(["policy", "--name", s3.name, "--provider", "mock"], cliEnv);
    expect(pol.code === 0 && /may use mock: allowed/.test(pol.stdout) && pol.stderr.includes(`derek.${engName}`), "agent policy shows allowed and the 4 levels");
    console.log(cliShow(pol));

    const tok = await runCli(["token", "--name", s3.name], cliEnv);
    const tokValue = tok.stdout.trim();
    let tokOk = false;
    try {
      const v = await verifyToken(tokValue);
      tokOk = isAddressEqual(v.signer, agent.address) && v.payload.name === s3.name && v.payload.exp <= Number(s3.expiry) && v.payload.aud === new URL(httpRelay.base).origin;
    } catch {}
    expect(tok.code === 0 && tokOk, `agent token prints a valid token for this relay, capped at the session's ENS expiry: ${tok.stderr.trim()}`);

    const env = await runCli(["env", "--name", s3.name], cliEnv);
    expect(
      env.code === 0 &&
        env.stdout.includes(`export ANTHROPIC_BASE_URL='${httpRelay.base}/claude'`) &&
        env.stdout.includes(`export OPENAI_BASE_URL='${httpRelay.base}/codex/v1'`) &&
        /export ANTHROPIC_API_KEY='kr1\./.test(env.stdout) &&
        /export OPENAI_API_KEY='kr1\./.test(env.stdout),
      "agent env prints quoted export lines for Claude Code and Codex",
    );

    const call = await runCli(["call", "--name", s3.name, "--provider", "mock"], cliEnv);
    expect(call.code === 0 && /← 200 allowed/.test(call.stdout) && /Hello from the mock provider/.test(call.stdout) && /cost: \$0\.01/.test(call.stderr), "agent call (mock) → 200, cost $0.01");
    console.log(cliShow(call));

    const denied = await runCli(["call", "--name", s3.name, "--provider", "github"], cliEnv);
    expect(denied.code === 1 && /refused by the relay: .*does not allow github/.test(denied.stdout), "agent call (github) → refused, exit code 1");
    console.log(cliShow(denied));

    const broke = await runCli(["primary-name", "--name", s3.name], cliEnv);
    expect(broke.code === 1 && /no Sepolia ETH/.test(broke.stderr), "agent primary-name with an empty key explains it needs gas");
    await test.setBalance({ address: agent.address, value: parseEther("0.01") });
    const primary = await runCli(["primary-name", "--name", s3.name], cliEnv);
    expect(primary.code === 0 && primary.stdout.includes(`is now ${s3.name}`), "agent primary-name sets the reverse record (ENSv1 ReverseRegistrar)");
    console.log(cliShow(primary));
    try {
      const shown = await pub.getEnsName({ address: agent.address, universalResolverAddress: ENSV2_SEPOLIA.UniversalResolverV2.address });
      expect(shown === s3.name, `UniversalResolverV2 reverse-resolves the agent to ${shown}`, String(shown));
    } catch (err) {
      note(`(UniversalResolverV2 reverse lookup not checked: ${formatError(err).split("\n")[0]})`);
    }

    completed = true;
  } finally {
    await httpRelay?.close();
    // Save the meter before deciding what to keep, so its exit hook has nothing left to write.
    await getMeter(path.join(tmp, "data")).flush();
    if (anvil) {
      anvil.kill("SIGTERM");
      console.log(`\n  (stopped the anvil this run started)`);
    }
    if (completed && failures === 0) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`\n  relay meter and agent key kept in ${tmp}`);
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nAll ${checks} checks passed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}`);
    console.log(`\nStopped early (${checks - failures} checks passed${failures ? `, ${failures} failed` : ""} before the error)`);
    process.exit(1);
  });
