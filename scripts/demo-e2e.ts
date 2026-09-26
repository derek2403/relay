// The whole demo.md story, end to end with assertions: `npm run demo:e2e`.
//
//   1. org-setup builds a fresh company (departments, teams, the launch squad and its alias)
//   2. ./relay init makes the user's key
//   3. the admin adds derek under dev with the portal's own calls; the relay's funder tops him up
//   4. ./relay login creates the agent codex.derek… with its own registry
//   5. the real Codex CLI runs through the relay as codex.derek… and, following its skill,
//      creates the subagents and runs the research subagent inside its sandbox
//   6. ./relay subagent create / exec / image as the subagents (one image, then refused)
//   7. a subagent's spend lands on every level above it
//   8. mia is allowed on the canonical path and refused through the alias
//   9. removing derek cuts off a live stream, then every call, then ./relay login
//  10. npm run demo:reset clears it all; derek can be added again and starts at $0
//
// The relay is the real app, built and served by `next start` (the CLI speaks HTTP) with a
// temporary data folder. OpenAI is a fake server in this process that speaks the Responses API
// (JSON and SSE) and image generation, so no real key is ever used: the relay gets a fake
// OPENAI_API_KEY, and every variable in the repo's .env files is blanked for it.
//
// Uses anvil on 127.0.0.1:8614 if one is running there, otherwise starts one (ANVIL_BIN,
// ~/.foundry/bin/anvil or anvil on PATH; FORK_URL picks the Sepolia RPC it forks) and stops it
// at the end. The relay runs on port 3314. The app is rebuilt when its source is newer than
// .next (--build forces it). Every run uses a fresh org label, so it can be re-run against the
// same fork. KEEP=1 keeps the temporary folder, VERBOSE=1 prints every command's output.

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  createPublicClient,
  createWalletClient,
  formatEther,
  http as viemHttp,
  isAddress,
  isAddressEqual,
  parseEther,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import { PermissionedResolverImplAbi } from "@/lib/ens/abis/PermissionedResolverImpl";
import { UserRegistryImplAbi } from "@/lib/ens/abis/UserRegistryImpl";
import { formatError } from "@/lib/ens/errors";
import { labelId, namehash } from "@/lib/ens/names";
import { RegistryRoles } from "@/lib/ens/roles";
import { bundleCalls } from "@/lib/relay/browser";
import type { Bundle } from "@/lib/relay/bundle";
import { CATALOG } from "@/lib/relay/catalog";
import { TREE_TTL_MS } from "@/lib/relay/owned";
import { createToken } from "@/lib/relay/token";
import type { FundResponse, LevelView, LogEntry, PolicyResponse } from "@/lib/relay/types";

import { chainNow, hasCode, miaAccount, readEntry, readParent, resolverAddress, walkName } from "./lib/ensv2";

const REPO = process.cwd();
const FORK_PORT = Number(process.env.E2E_FORK_PORT || 8614);
const RELAY_PORT = Number(process.env.E2E_RELAY_PORT || 3314);
const RPC = `http://127.0.0.1:${FORK_PORT}`;
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const FORK_URL = process.env.FORK_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const LIVE_CHECK_SEC = 2;
const FAKE_OPENAI_KEY = "sk-e2e-fake-openai-key-not-real";
const ADMIN_TOKEN = `e2e-admin-${randomBytes(12).toString("hex")}`;
// Anvil's well-known dev keys #0 (admin) and #9 (gas funder): public, they only hold fork ETH.
const ADMIN_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const FUNDER_KEY: Hex = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const VERBOSE = !!process.env.VERBOSE;
const KEEP = !!process.env.KEEP;
const DAY = 86_400;

// The prompts the fake OpenAI recognizes.
const AGENT_MARK = "[e2e-agent]";
/** "[e2e-slow:<label>]": a slow stream the test can find by its label. */
const SLOW_MARK = "[e2e-slow";
const FINAL_TEXT = "E2E-FINAL: the research and image subagents are ready and research answered.";

// --- Output and assertions -------------------------------------------------------

let checks = 0;

class Failure extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

const section = (title: string) => console.log(`\n${title}`);
const note = (line: string) => console.log(`    ${line}`);
const ok = (msg: string) => {
  checks++;
  console.log(`  ✓ ${msg}`);
};

function check(cond: unknown, msg: string, detail?: string | (() => string)): asserts cond {
  if (!cond) throw new Failure(msg, typeof detail === "function" ? detail() : detail);
  ok(msg);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const indent = (text: string, prefix = "      | ") =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `${prefix}${l}`)
    .join("\n");

// --- Processes ---------------------------------------------------------------------

type Run = { code: number; stdout: string; stderr: string; all: string; ms: number; cmd: string };

const running = new Set<ChildProcess>();

/** Runs a command to completion with no stdin (codex exec would wait on an open pipe). */
function run(cmd: string, args: string[], opts: { env?: Record<string, string | undefined>; cwd?: string; timeoutMs?: number } = {}): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...opts.env })) if (v !== undefined) env[k] = v;
  const shown = `${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd: opts.cwd ?? REPO, env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    const out = { stdout: "", stderr: "", all: "" };
    child.stdout!.on("data", (d) => ((out.stdout += String(d)), (out.all += String(d))));
    child.stderr!.on("data", (d) => ((out.stderr += String(d)), (out.all += String(d))));
    const timer = setTimeout(() => {
      out.all += `\n[demo-e2e] timed out after ${opts.timeoutMs} ms`;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs ?? 180_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      running.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      running.delete(child);
      const r = { code: code ?? 1, ...out, ms: Date.now() - started, cmd: shown };
      if (VERBOSE) console.log(`    $ ${shown}  (exit ${r.code}, ${(r.ms / 1000).toFixed(1)} s)\n${indent(r.all)}`);
      resolve(r);
    });
  });
}

const showRun = (r: Run) => `$ ${r.cmd}  (exit ${r.code})\n${r.all.trim()}`;

const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

// --- Anvil ----------------------------------------------------------------------------

async function rpcChainId(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
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
  const existing = await rpcChainId(RPC);
  if (existing) {
    if (Number(existing) !== sepolia.id) throw new Failure(`Port ${FORK_PORT} is serving chain ${Number(existing)}, not a Sepolia fork.`);
    ok(`using the anvil fork already running on ${RPC}`);
    return null;
  }
  const bin = findAnvil();
  if (!bin) throw new Failure(`No anvil found. Install Foundry, set ANVIL_BIN, or start one: anvil --fork-url ${FORK_URL} --port ${FORK_PORT}`);
  const child = spawn(bin, ["--fork-url", FORK_URL, "--port", String(FORK_PORT), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr += String(d)));
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Failure(`anvil exited (${child.exitCode})`, stderr.trim().slice(0, 500));
    if (await rpcChainId(RPC)) {
      ok(`started anvil forking ${FORK_URL} on ${RPC}`);
      return child;
    }
    await sleep(200);
  }
  child.kill("SIGTERM");
  throw new Failure("anvil did not start within 60 s");
}

// --- The relay (next build + next start) ---------------------------------------------------

const NEXT_BIN = path.join(REPO, "node_modules", ".bin", "next");

/** Newest modification time of what goes into the build (tests excluded). */
function newestSource(): number {
  let newest = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/\.test\.tsx?$/.test(e.name)) newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  for (const d of ["app", "lib", "components", "public"]) walk(path.join(REPO, d));
  for (const f of ["next.config.ts", "package.json", "package-lock.json", "tsconfig.json", "postcss.config.mjs"]) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(REPO, f)).mtimeMs);
    } catch {}
  }
  return newest;
}

async function buildRelay(logFile: string): Promise<string> {
  let builtAt = 0;
  try {
    builtAt = fs.statSync(path.join(REPO, ".next", "BUILD_ID")).mtimeMs;
  } catch {}
  if (!process.argv.includes("--build") && builtAt > newestSource()) return "the relay's build is up to date (.next; pass --build to rebuild)";
  // `next dev` writes to .next/dev, so this doesn't disturb a dev server running in this repo.
  const r = await run(NEXT_BIN, ["build"], { timeoutMs: 15 * 60_000, env: { NEXT_TELEMETRY_DISABLED: "1" } });
  fs.writeFileSync(logFile, r.all);
  if (r.code !== 0) throw new Failure("next build failed", r.all.split("\n").slice(-40).join("\n"));
  return `built the relay (next build, ${Math.round(r.ms / 1000)} s)`;
}

/** Keys the repo's .env files set, so the test relay can blank them (a real key must never leak in). */
function envFileKeys(): string[] {
  const keys = new Set<string>();
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(REPO, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys];
}

async function startRelay(opts: { root: string; rootOwner: Address; dataDir: string; fakeOpenAI: string; logFile: string }): Promise<ChildProcess> {
  if (await fetch(`${RELAY}/api/relay/status`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false)) {
    throw new Failure(`Something is already answering on ${RELAY} (a relay left from an earlier run?). Stop it or set E2E_RELAY_PORT.`);
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // An empty variable is "set" for Next, so nothing from .env files reaches this relay.
  for (const k of envFileKeys()) env[k] = "";
  for (const p of CATALOG) if (p.keyEnv) env[p.keyEnv] = "";
  Object.assign(env, {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    RELAY_RPC_URL: RPC,
    NEXT_PUBLIC_SEPOLIA_RPC_URL: RPC,
    RELAY_ROOT_NAME: opts.root,
    RELAY_ROOT_OWNER: opts.rootOwner,
    RELAY_DATA_DIR: opts.dataDir,
    RELAY_PUBLIC_URL: RELAY,
    RELAY_ADMIN_TOKEN: ADMIN_TOKEN,
    RELAY_LIVE_CHECK_SEC: String(LIVE_CHECK_SEC),
    FUNDER_PRIVATE_KEY: FUNDER_KEY,
    FUNDER_AMOUNT_ETH: "0.01",
    FUNDER_MIN_BALANCE_ETH: "0.005",
    FUNDER_DAILY_LIMIT_ETH: "0.5",
    OPENAI_API_KEY: FAKE_OPENAI_KEY,
    RELAY_UPSTREAM_CODEX: opts.fakeOpenAI,
    RELAY_UPSTREAM_OPENAI_IMAGES: opts.fakeOpenAI,
  });
  const log = fs.openSync(opts.logFile, "w");
  // Its own process group, so stopping it also stops the workers next start spawns.
  const child = spawn(NEXT_BIN, ["start", "-p", String(RELAY_PORT), "-H", "127.0.0.1"], { cwd: REPO, env: env as NodeJS.ProcessEnv, stdio: ["ignore", log, log], detached: true });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Failure(`next start exited (${child.exitCode})`, fs.readFileSync(opts.logFile, "utf8").slice(-2000));
    const res = await fetch(`${RELAY}/api/relay/status`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (res?.ok) return child;
    await sleep(250);
  }
  stopGroup(child);
  throw new Failure("the relay did not answer within 60 s", fs.readFileSync(opts.logFile, "utf8").slice(-2000));
}

function stopGroup(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

// --- Fake OpenAI -------------------------------------------------------------------------

/** A 1x1 PNG. */
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const USAGE = { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1200 };

type Seen = { ts: number; method: string; path: string; authorization: string | null; hasToken: boolean; model: string | null; stream: boolean; kind: string };
type InputItem = { type?: string; role?: string; output?: unknown; content?: unknown };

/**
 * Just enough of OpenAI for Codex and ./relay image: POST /v1/responses (SSE or JSON, usage in
 * response.completed) and POST /v1/images/generations (b64 PNG). It records what it receives.
 * - a prompt with AGENT_MARK gets one scripted turn: Codex's exec tool runs the skill's commands
 * - a prompt with "[e2e-slow:<label>]" streams a delta every 200 ms for up to 60 s (the live-kill test)
 * - anything else gets a short answer
 */
class FakeOpenAI {
  readonly seen: Seen[] = [];
  readonly toolOutputs: string[] = [];
  readonly slow = new Map<string, { startedAt: number; closedAt: number | null }>();
  private scripted = false;
  private turn = 0;
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = "";

  constructor(readonly logFile: string) {}

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close() {
    this.server.closeAllConnections();
    this.server.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    const headerText = JSON.stringify(req.headers);
    const seen: Seen = {
      ts: Date.now(),
      method: req.method ?? "GET",
      path: req.url ?? "/",
      authorization: req.headers.authorization ?? null,
      hasToken: /kr1\.[A-Za-z0-9_-]{16,}/.test(headerText + raw),
      model: typeof body?.model === "string" ? body.model : null,
      stream: body?.stream === true,
      kind: "other",
    };
    this.seen.push(seen);
    const logLine = (extra: object) => fs.appendFileSync(this.logFile, `${JSON.stringify({ ...seen, ...extra })}\n`);

    if (req.method === "POST" && req.url?.split("?")[0] === "/v1/images/generations") {
      seen.kind = "image";
      logLine({ prompt: body?.prompt });
      const n = typeof body?.n === "number" ? body.n : 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: Math.floor(Date.now() / 1000), data: Array.from({ length: n }, () => ({ b64_json: PNG_1PX })) }));
      return;
    }
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/responses" || !body) {
      logLine({});
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `fake OpenAI has no ${req.method} ${req.url}`, type: "invalid_request_error" } }));
      return;
    }

    const input: InputItem[] = Array.isArray(body.input) ? (body.input as InputItem[]) : [{ role: "user", content: String(body.input ?? "") }];
    const last = input[input.length - 1];
    const id = `resp_e2e_${++this.turn}`;
    const model = seen.model ?? "gpt-5";

    if (raw.includes(SLOW_MARK)) {
      seen.kind = "slow";
      logLine({});
      return this.slowStream(res, id, model, raw.match(/\[e2e-slow:(\w+)\]/)?.[1] ?? "unlabeled");
    }
    let items: object[];
    if (last?.type === "custom_tool_call_output" || last?.type === "function_call_output") {
      seen.kind = "after-tool";
      this.toolOutputs.push(outputText(last.output));
      items = [message(`msg_${id}`, FINAL_TEXT)];
    } else if (!this.scripted && raw.includes(AGENT_MARK)) {
      // One scripted turn: what the ens-subagents skill tells Codex to do, through Codex's exec tool.
      this.scripted = true;
      seen.kind = "tool-call";
      items = [{ type: "custom_tool_call", id: `ctc_${id}`, call_id: `call_${id}`, name: "exec", status: "completed", input: SKILL_SCRIPT }];
    } else {
      seen.kind = "answer";
      items = [message(`msg_${id}`, "ENS names as agent identities.")];
    }
    logLine({ inputTail: JSON.stringify(input.slice(-1)).slice(0, 400) });

    if (!seen.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, object: "response", model, status: "completed", output: items, usage: USAGE }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("response.created", { response: { id, model, status: "in_progress" } });
    items.forEach((item, i) => send("response.output_item.done", { output_index: i, item }));
    send("response.completed", { response: { id, model, status: "completed", output: items, usage: USAGE } });
    res.end();
  }

  private slowStream(res: http.ServerResponse, id: string, model: string, label: string) {
    const slow = { startedAt: Date.now(), closedAt: null as number | null };
    this.slow.set(label, slow);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.flushHeaders();
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("response.created", { response: { id, model, status: "in_progress" } });
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 300) {
        clearInterval(timer);
        send("response.completed", { response: { id, model, status: "completed", usage: USAGE } });
        res.end();
        return;
      }
      send("response.output_text.delta", { item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: `tick ${n} ` });
    }, 200);
    // The relay stops the upstream call when it kills the stream.
    res.on("close", () => {
      clearInterval(timer);
      slow.closedAt ??= Date.now();
    });
  }
}

const message = (id: string, text: string) => ({ type: "message", role: "assistant", id, status: "completed", content: [{ type: "output_text", text, annotations: [] }] });

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((o) => (typeof o === "string" ? o : ((o as { text?: string }).text ?? JSON.stringify(o)))).join("\n");
  return JSON.stringify(output);
}

/** The ens-subagents skill's commands, as a script for Codex's exec tool (tools.exec_command in its sandbox). */
const SKILL_COMMANDS = [
  "./relay subagent create research --codex 1 --minutes 20",
  "./relay subagent create image --images 1 --minutes 20",
  `./relay exec --as research "Name the most popular ENS use case in five words."`,
];
const SKILL_SCRIPT = SKILL_COMMANDS.map(
  (cmd, i) =>
    `const r${i} = await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, yield_time_ms: 120000, max_output_tokens: 6000 });\n` +
    `text(${JSON.stringify(`$ ${cmd}\n`)} + "exit=" + r${i}.exit_code + "\\n" + r${i}.output + "\\n");`,
).join("\n");

// --- Chain ----------------------------------------------------------------------------------

const transport = viemHttp(RPC, { timeout: 60_000 });
const pub = createPublicClient({ chain: sepolia, transport, pollingInterval: 100 }) as PublicClient;
const admin = privateKeyToAccount(ADMIN_KEY);
// org:setup derives mia's key from the admin's.
const MIA = miaAccount(ADMIN_KEY);
const wallet = createWalletClient({ account: admin, chain: sepolia, transport });

async function receiptOf(hash: Hex): Promise<TransactionReceipt> {
  for (let i = 0; i < 600; i++) {
    const r = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (r) return r;
    await sleep(100);
  }
  throw new Failure(`transaction ${hash} was not mined within 60 s`);
}

/** One admin transaction (simulated first, for a readable revert reason). */
async function adminWrite(address: Address, abi: Abi, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
  let hash: Hex;
  try {
    const { request } = await pub.simulateContract({ account: admin, address, abi, functionName, args } as never);
    hash = await wallet.writeContract(request as never);
  } catch (err) {
    throw new Failure(`admin: ${functionName} failed`, formatError(err));
  }
  const receipt = await receiptOf(hash);
  if (receipt.status !== "success") throw new Failure(`admin: ${functionName} reverted (${hash})`);
  return receipt;
}

// --- Relay HTTP -------------------------------------------------------------------------------

const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function getJson<T>(url: string, init: RequestInit = {}): Promise<{ status: number; json: T; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let json = null as T;
  try {
    json = JSON.parse(text) as T;
  } catch {}
  return { status: res.status, json, text };
}

async function policy(name: string, provider: string | null): Promise<PolicyResponse> {
  const q = new URLSearchParams({ name });
  if (provider) q.set("provider", provider);
  const r = await getJson<PolicyResponse>(`${RELAY}/api/relay/policy?${q}`, { headers: asAdmin });
  if (r.status !== 200) throw new Failure(`/api/relay/policy for ${name} answered ${r.status}`, r.text.slice(0, 500));
  return r.json;
}

async function relayLog(): Promise<LogEntry[]> {
  const r = await getJson<LogEntry[]>(`${RELAY}/api/relay/log?limit=500`, { headers: asAdmin });
  if (r.status !== 200 || !Array.isArray(r.json)) throw new Failure(`/api/relay/log answered ${r.status}`, r.text.slice(0, 500));
  return r.json;
}

async function fund(name: string) {
  return getJson<FundResponse>(`${RELAY}/api/fund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
}

const usd = (n: number | undefined) => `$${(n ?? 0).toFixed(4)}`;
const near = (a: number | undefined, b: number) => Math.abs((a ?? 0) - b) < 1e-9;
const short = (name: string) => name.split(".").slice(0, 2).join(".") + "…";

// --- The story ----------------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(path.join(REPO, "scripts", "demo-e2e.ts"))) throw new Failure("Run this from the repo root: npm run demo:e2e");
  console.log("Keyless Relay: the demo.md flow end to end (anvil fork + next start + real Codex + fake OpenAI)");

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "keyless-e2e-")));
  const home = path.join(tmp, "relay-home");
  const codexHome = path.join(tmp, "codex-home");
  const dataDir = path.join(tmp, "data");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const org = `e2e${Date.now().toString(36)}`;
  const root = `${org}.eth`;
  const eng = `eng.${root}`;
  const dev = `dev.${eng}`;
  const derek = `derek.${dev}`;
  const agent = `codex.${derek}`;
  const research = `research.${agent}`;
  const image = `image.${agent}`;

  // ./relay codex rewrites demo-workspace's AGENTS.md and skill for this org; they're put back at the end.
  const workspaceFiles = ["demo-workspace/AGENTS.md", "demo-workspace/.agents/skills/ens-subagents/SKILL.md"].map((f) => path.join(REPO, f));
  const savedWorkspace = new Map(workspaceFiles.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null]));

  const cliEnv = { RELAY_HOME: home, RELAY_URL: RELAY, RELAY_RPC_URL: RPC, CODEX_HOME: codexHome, RELAY_IMAGE_MODEL: "gpt-image-1" };
  const cli = (args: string[], timeoutMs = 180_000) => run(path.join(REPO, "relay"), args, { env: cliEnv, timeoutMs });
  const lastJsonLine = <T>(text: string): T | null => {
    for (const line of text.trim().split("\n").reverse()) {
      try {
        return JSON.parse(line) as T;
      } catch {}
    }
    return null;
  };

  const fake = new FakeOpenAI(path.join(tmp, "fake-openai.log"));
  let anvil: ChildProcess | null = null;
  let relay: ChildProcess | null = null;
  let passed = false;

  const cleanup = async () => {
    for (const child of running) child.kill("SIGTERM");
    if (relay) stopGroup(relay);
    fake.close();
    if (anvil) anvil.kill("SIGTERM");
    for (const [file, text] of savedWorkspace) {
      try {
        if (text === null) fs.rmSync(file, { force: true });
        else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
      } catch {}
    }
    if (passed && !KEEP) fs.rmSync(tmp, { recursive: true, force: true });
    else console.log(`\n  logs, meter and keys kept in ${tmp}`);
  };
  const onSignal = () => {
    console.log("\n  interrupted; cleaning up");
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    // Setup ------------------------------------------------------------------------------------
    section("Setup");
    await fake.start();
    ok(`fake OpenAI (Responses API + images) on ${fake.url}`);
    anvil = await ensureAnvil();
    const [built, orgRun] = await Promise.all([
      buildRelay(path.join(tmp, "next-build.log")),
      // 1. runs while the app builds
      run(NPM, ["run", "-s", "org:setup"], { env: { ADMIN_PRIVATE_KEY: ADMIN_KEY, ORG_LABEL: org, RELAY_RPC_URL: RPC }, timeoutMs: 10 * 60_000 }),
    ]);
    ok(built);
    relay = await startRelay({ root, rootOwner: admin.address, dataDir, fakeOpenAI: fake.url, logFile: path.join(tmp, "next-start.log") });
    ok(`relay (next start) on ${RELAY}: root ${root}, live check every ${LIVE_CHECK_SEC} s, funder = anvil #9, OpenAI = the fake`);

    // 1 ------------------------------------------------------------------------------------------
    section(`1. npm run org:setup builds ${root}`);
    check(orgRun.code === 0 && orgRun.stdout.includes(`RELAY_ROOT_NAME=${root}`), `org-setup finished (${Math.round(orgRun.ms / 1000)} s)`, () => showRun(orgRun));
    const sent = orgRun.stdout.match(/Done \((\d+) transactions\)/)?.[1];
    note(`${sent ?? "?"} transactions; it prints RELAY_ROOT_NAME=${root} and RELAY_ROOT_OWNER=${admin.address}`);
    const devWalk = await walkName(pub, dev);
    const devEntry = devWalk.levels.at(-1)!.entry;
    const devRegistry = devEntry?.subregistry;
    check(!devWalk.broken && devRegistry && isAddressEqual(devEntry!.owner!, admin.address), `${dev} is registered to the admin with its own registry ${devRegistry}`);
    const adminResolver = await resolverAddress(pub, admin.address);
    const status = await getJson<{ root: string; providers: { id: string; configured: boolean }[]; funder?: { enabled: boolean } }>(`${RELAY}/api/relay/status`);
    const configured = status.json.providers.filter((p) => p.configured).map((p) => p.id);
    check(
      status.json.root === root && configured.includes("codex") && configured.includes("openai-images") && !configured.includes("claude") && status.json.funder?.enabled,
      `the relay serves ${root} with only the fake OpenAI key (configured: ${configured.join(", ")}) and a funder`,
    );

    // 2 ------------------------------------------------------------------------------------------
    section("2. ./relay init");
    const init = await cli(["init", "--relay", RELAY, "--rpc", RPC]);
    const userAddress = init.stdout.trim().split("\n")[0] as Address;
    check(init.code === 0 && isAddress(userAddress), `prints the user's address ${userAddress}`, () => showRun(init));
    check((fs.statSync(home).mode & 0o777) === 0o700 && (fs.statSync(path.join(home, "user.json")).mode & 0o777) === 0o600, "the key is in RELAY_HOME (folder 700, file 600)");
    const early = await cli(["login"]);
    const earlyAt = Date.now();
    check(early.code === 1 && early.stderr.includes(`No ENS name found for ${userAddress}. Ask your admin to add this address.`), "login before the admin adds the address: 'No ENS name found'", () => showRun(early));

    // 3 ------------------------------------------------------------------------------------------
    section(`3. The admin adds ${derek} (the portal's calls) and the funder tops him up`);
    const derekBundle: Bundle = { keys: ["codex", "openai-images", "github", "linear"], caps: { codex: 20 }, maxes: { "openai-images": 5 }, period: "month" };
    const addMember = async (label: string, owner: Address, bundle: Bundle) => {
      // AddMember.tsx: register (members get ROLE_SET_SUBREGISTRY only), then write the limits on the admin's resolver.
      const expiry = BigInt((await chainNow(pub)) + 30 * DAY);
      await adminWrite(devRegistry, UserRegistryImplAbi, "register", [label, owner, zeroAddress, adminResolver, RegistryRoles.ROLE_SET_SUBREGISTRY, expiry]);
      await adminWrite(adminResolver, PermissionedResolverImplAbi, "multicall", [bundleCalls(`${label}.${dev}`, bundle, { unlink: true })]);
    };
    await addMember("derek", userAddress, derekBundle);
    let p = await policy(derek, "codex");
    const derekLevel = p.levels.at(-1)!;
    check(
      p.allowed && derekLevel.owner && isAddressEqual(derekLevel.owner, userAddress) && derekLevel.bundle?.caps.codex === 20 && derekLevel.bundle?.maxes?.["openai-images"] === 5,
      `registered derek (owner = the user, ROLE_SET_SUBREGISTRY) with codex $20 · openai-images 5 · github · linear / month`,
      () => JSON.stringify(p, null, 1).slice(0, 1500),
    );
    const before = await pub.getBalance({ address: userAddress });
    const funded = await fund(derek);
    const after = await pub.getBalance({ address: userAddress });
    check(
      funded.status === 200 && funded.json?.funded === true && after - before === parseEther(funded.json.amountEth),
      `POST /api/fund sent ${funded.json?.funded ? funded.json.amountEth : "?"} ETH: balance ${formatEther(before)} → ${formatEther(after)}`,
      funded.text,
    );
    const again = await fund(derek);
    check(again.json?.funded === false && /already funded/.test(again.json.reason), `a second top-up is refused: ${again.json && !again.json.funded ? again.json.reason : again.text}`);

    // 4 ------------------------------------------------------------------------------------------
    section("4. ./relay login");
    // The relay reuses its walk of the tree for a few seconds (the "no name" answer above); on Sepolia
    // the portal's two transactions alone take longer than that.
    await sleep(Math.max(0, earlyAt + TREE_TTL_MS + 500 - Date.now()));
    const login = await cli(["login"]);
    check(login.code === 0 && login.stderr.includes(`Session ready: ${agent}`), `creates ${agent} (${Math.round(login.ms / 1000)} s)`, () => showRun(login));
    if (VERBOSE) console.log(indent(login.stderr));
    const agentKey = JSON.parse(fs.readFileSync(path.join(home, "agents", `${agent}.json`), "utf8")) as { address: Address };
    const agentWalk = await walkName(pub, agent);
    const derekW = agentWalk.levels.at(-2)!;
    const agentW = agentWalk.levels.at(-1)!;
    const derekRegistry = derekW.entry?.subregistry;
    const agentRegistry = agentW.entry?.subregistry;
    check(!agentWalk.broken && derekRegistry && (await hasCode(pub, derekRegistry)), `derek's own registry ${derekRegistry} is attached under derek`);
    const agentRoles = await pub.readContract({ address: derekRegistry, abi: UserRegistryImplAbi, functionName: "roles", args: [agentW.entry!.resource, agentKey.address] });
    check(
      agentW.entry?.owner && isAddressEqual(agentW.entry.owner, agentKey.address) && agentRoles === 0n,
      `${short(agent)} is owned by the agent key ${agentKey.address} with no roles`,
    );
    const agentParent = agentRegistry ? await readParent(pub, agentRegistry) : null;
    check(
      agentRegistry && (await hasCode(pub, agentRegistry)) && agentParent && isAddressEqual(agentParent.parent, derekRegistry) && agentParent.label === "codex",
      `the agent has its own registry ${agentRegistry} (deployed by the user, parent = derek's registry)`,
    );
    p = await policy(agent, "codex");
    const agentBundle = p.levels.at(-1)?.bundle;
    check(
      p.allowed && p.levels.length === 5 && agentBundle?.caps.codex === 5 && agentBundle.maxes?.["openai-images"] === 2 && agentBundle.period === "total",
      `its limits on the user's resolver: codex $5 · 2 images / total; the relay allows it (5 levels, all canonical)`,
      () => JSON.stringify(p.levels.at(-1), null, 1),
    );
    const whoami = await cli(["whoami", "--json"]);
    let who: { address: string; names: { name: string }[]; agent: { name: string; status: string; usage: string | null } | null } | null = null;
    try {
      who = JSON.parse(whoami.stdout);
    } catch {}
    check(
      whoami.code === 0 && who?.agent?.name === agent && who.agent.status === "active" && who.names.some((n) => n.name === derek),
      `./relay whoami shows ${short(derek)} and the agent ${short(agent)}: ${who?.agent?.usage}`,
      () => showRun(whoami),
    );

    // 5 ------------------------------------------------------------------------------------------
    section("5. The real Codex CLI works through the relay as the agent");
    const seenBefore = fake.seen.length;
    const task = `${AGENT_MARK} Research the three most popular ENS use cases this year and make a one-page brief with a header image.`;
    const codexRun = await cli(["codex", "exec", task], 300_000);
    check(codexRun.code === 0 && codexRun.stdout.includes(FINAL_TEXT), `./relay codex exec "…" finished a turn (${Math.round(codexRun.ms / 1000)} s)`, () => showRun(codexRun));
    let log = await relayLog();
    const agentCalls = log.filter((e) => e.name === agent && e.provider === "codex" && e.allowed && e.status === 200);
    const agentCharged = agentCalls.reduce((s, e) => s + (e.costUsd ?? 0), 0);
    check(
      agentCalls.length >= 2 && agentCalls.every((e) => (e.costUsd ?? 0) > 0),
      `the relay log shows ${agentCalls.length} allowed codex calls by ${short(agent)}, charged ${usd(agentCharged)} in total`,
      () => JSON.stringify(log.slice(0, 5), null, 1),
    );
    const codexSeen = fake.seen.slice(seenBefore).filter((s) => s.path.startsWith("/v1/responses"));
    check(
      codexSeen.length >= 2 && codexSeen.every((s) => s.authorization === `Bearer ${FAKE_OPENAI_KEY}` && !s.hasToken),
      `the fake OpenAI got ${codexSeen.length} Responses calls, all with the relay's OpenAI key and never a kr1 token`,
    );
    const toolOut = fake.toolOutputs.join("\n");
    const exits = [...toolOut.matchAll(/^exit=(\S+)/gm)].map((m) => m[1]);
    check(
      exits.length === 3 && exits.every((x) => x === "0") && toolOut.includes(`"name":"${research}"`) && toolOut.includes(`"name":"${image}"`),
      "inside its sandbox, Codex ran the skill: created research and image, then ran ./relay exec --as research",
      () => toolOut || "(no tool output came back; Codex may not have run the exec tool)",
    );
    const nested = log.filter((e) => e.name === research && e.provider === "codex" && e.allowed && e.status === 200);
    check(nested.length >= 1 && nested.every((e) => (e.costUsd ?? 0) > 0), `the research subagent's own Codex ran through the relay as ${short(research)} (${nested.length} calls)`);

    // 6 ------------------------------------------------------------------------------------------
    section("6. Subagents: create, exec and image");
    for (const [label, flags, name] of [
      ["research", ["--codex", "1"], research],
      ["image", ["--images", "1"], image],
    ] as const) {
      const r = await cli(["subagent", "create", label, ...flags, "--minutes", "20"]);
      const out = lastJsonLine<{ name: string; expiry: number }>(r.stdout);
      const key = JSON.parse(fs.readFileSync(path.join(home, "agents", `${name}.json`), "utf8")) as { address: Address };
      const entry = await readEntry(pub, agentRegistry, label);
      const left = entry.expiry - (await chainNow(pub));
      check(
        r.code === 0 && out?.name === name && entry.registered && entry.owner && isAddressEqual(entry.owner, key.address) && left > 15 * 60 && left <= 20 * 60 + 5,
        `./relay subagent create ${label} ${flags.join(" ")} --minutes 20 → ${short(name)} (owner = its own key, ${Math.round(left / 60)} min left)`,
        () => showRun(r),
      );
    }
    p = await policy(research, "codex");
    const beforeResearch = p.levels.map((l) => l.spent.codex ?? 0);
    check(p.allowed && p.levels.length === 6 && p.levels.at(-1)?.bundle?.caps.codex === 1, "research: codex $1 / total, allowed through all 6 levels");
    const exec = await cli(["exec", "--as", "research", "Summarize the three most popular ENS use cases in one line each."], 180_000);
    check(exec.code === 0 && exec.stderr.includes(`Running Codex as ${research}`), `./relay exec --as research "…" ran codex exec as ${short(research)}`, () => showRun(exec));
    const headerPng = path.join(tmp, "header.png");
    const img1 = await cli(["image", "--as", "image", "--prompt", "A torii gate made of ENS names", "--out", headerPng]);
    const png = fs.existsSync(headerPng) ? fs.readFileSync(headerPng) : Buffer.alloc(0);
    check(img1.code === 0 && png.subarray(1, 4).toString() === "PNG", `./relay image --as image saved a PNG (${png.length} bytes)`, () => showRun(img1));
    const img2 = await cli(["image", "--as", "image", "--prompt", "Another one", "--out", path.join(tmp, "second.png")]);
    check(
      img2.code === 1 && /has used its openai-images limit \(1 images?\)/.test(img2.stderr) && !fs.existsSync(path.join(tmp, "second.png")),
      `a second image is refused: ${img2.stderr.trim().split("\n").at(-1)}`,
      () => showRun(img2),
    );

    // 7 ------------------------------------------------------------------------------------------
    section("7. A child can't beat its parents: its spend lands on every level");
    p = await policy(research, "codex");
    const deltas = p.levels.map((l, i) => (l.spent.codex ?? 0) - beforeResearch[i]);
    check(
      deltas[5] > 0 && deltas.every((d) => near(d, deltas[5])),
      `research's ${usd(deltas[5])} was added to all 6 levels: ${p.levels.map((l, i) => `${l.name.split(".")[0]} +${usd(deltas[i])}`).join(", ")}`,
    );
    const imgPolicy = await policy(image, "openai-images");
    const used = (l: LevelView) => l.used?.["openai-images"] ?? 0;
    check(
      imgPolicy.levels.every((l) => used(l) >= 1) && used(imgPolicy.levels[5]) === 1 && used(imgPolicy.levels[4]) === 1 && used(imgPolicy.levels[3]) === 1 && !imgPolicy.allowed,
      `the image counts at every level: ${imgPolicy.levels.map((l) => `${l.name.split(".")[0]} ${used(l)}`).join(", ")} (image refused: ${imgPolicy.reason})`,
    );
    const ceilings = p.levels.map((l) => l.bundle?.caps.codex);
    note(`codex caps from the top: ${ceilings.map((c) => (c === undefined ? "-" : `$${c}`)).join(" → ")}`);

    // 8 ------------------------------------------------------------------------------------------
    section("8. Aliasing: one squad, two paths, only the canonical one works");
    const miaCanonical = `mia.launch.${dev}`;
    const miaAlias = `mia.launch.growth.marketing.${root}`;
    const pc = await policy(miaCanonical, "codex");
    check(pc.allowed && pc.levels.every((l) => l.checks.canonical !== false), `policy: ${miaCanonical} is allowed`, () => JSON.stringify(pc, null, 1).slice(0, 1500));
    const pa = await policy(miaAlias, "codex");
    check(!pa.allowed && /not canonical/.test(pa.reason ?? ""), `policy: ${miaAlias} is refused: ${pa.reason}`);
    const miaToken = async (name: string) => createToken(MIA, { name, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, aud: RELAY });
    const miaCall = async (name: string) =>
      getJson<{ error?: string; reason?: string; output?: unknown }>(`${RELAY}/api/relay/codex/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${await miaToken(name)}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5", input: "hi", max_output_tokens: 256 }),
      });
    const viaCanonical = await miaCall(miaCanonical);
    check(viaCanonical.status === 200 && Array.isArray(viaCanonical.json?.output), `a call signed by mia's key as ${short(miaCanonical)} → 200`, viaCanonical.text);
    const viaAlias = await miaCall(miaAlias);
    check(viaAlias.status === 403 && /not canonical/.test(viaAlias.json?.reason ?? ""), `the same key as ${short(miaAlias)} → 403 (not canonical)`, viaAlias.text);

    // 9 ------------------------------------------------------------------------------------------
    section(`9. Revoke: the admin removes ${derek} while two responses are streaming`);
    // Real Codex on a slow answer (what the demo audience sees), and a raw stream to time the kill exactly.
    const codexLive = cli(["codex", "exec", "[e2e-slow:codex] Write a long essay about ENS."], 120_000);
    const tok = await cli(["token"]);
    const agentToken = tok.stdout.trim();
    check(tok.code === 0 && agentToken.startsWith("kr1."), `./relay token signed a token for ${short(agent)}`, () => showRun(tok));
    const stream = await fetch(`${RELAY}/api/relay/codex/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", "accept-encoding": "identity" },
      body: JSON.stringify({ model: "gpt-5", input: "[e2e-slow:raw] count slowly", stream: true, max_output_tokens: 1000 }),
      signal: AbortSignal.timeout(90_000),
    });
    check(stream.status === 200 && (stream.headers.get("content-type") ?? "").includes("text/event-stream"), "a raw streaming call as the agent is running (slow fake SSE)");
    const live = { received: "", closedAt: null as number | null };
    const consumer = (async () => {
      const reader = stream.body!.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          live.received += dec.decode(value, { stream: true });
        }
      } catch (err) {
        live.received += `\n[read error: ${err instanceof Error ? err.message : String(err)}]`;
      }
      live.closedAt = Date.now();
    })();
    for (let i = 0; i < 100 && !live.received.includes("response.output_text.delta"); i++) await sleep(100);
    check(live.received.includes("response.output_text.delta"), "its deltas are arriving through the relay", live.received.slice(0, 500));
    for (let i = 0; i < 600 && !fake.slow.get("codex"); i++) await sleep(100);
    check(fake.slow.get("codex"), "Codex (./relay codex exec) is streaming a long answer through the relay too");
    await sleep(500);

    // The portal's Remove button: unregister on dev's registry (the admin holds every role there).
    // Times are measured from sending it: an upper bound on how long the kill took.
    const removedAt = Date.now();
    await adminWrite(devRegistry, UserRegistryImplAbi, "unregister", [labelId("derek")]);
    ok("the admin unregistered derek on dev's registry (the portal's Remove button)");
    await Promise.race([consumer, sleep(15_000)]);
    const closedIn = live.closedAt === null ? null : live.closedAt - removedAt;
    const received = live.received;
    const errorEvent = received.split("\n\n").find((e) => e.startsWith("event: error"));
    const errorData = errorEvent ? JSON.parse(errorEvent.slice(errorEvent.indexOf("data: ") + 6)) : null;
    check(
      !!errorData && /^access revoked: derek\..* was removed or expired\. Run \.\/relay login\.$/.test(errorData.message ?? errorData.error?.message ?? ""),
      `the raw stream ended with the error event: "${errorData?.message ?? "(none)"}"`,
      received.slice(-600),
    );
    const limitMs = 2 * LIVE_CHECK_SEC * 1000 + 1000;
    check(closedIn !== null && closedIn <= limitMs, `and closed ${closedIn} ms after the removal was sent (live check every ${LIVE_CHECK_SEC} s)`);
    const rawUpstream = fake.slow.get("raw");
    for (let i = 0; i < 30 && !rawUpstream?.closedAt; i++) await sleep(100);
    check(rawUpstream?.closedAt, `the relay stopped the upstream call too (${rawUpstream?.closedAt ? rawUpstream.closedAt - removedAt : "?"} ms)`);
    const codexEnd = await codexLive;
    const codexUpstream = fake.slow.get("codex");
    const codexSaid = codexEnd.all.split("\n").filter((l) => /access revoked/.test(l));
    check(
      codexEnd.code !== 0 && codexSaid.length > 0 && codexUpstream?.closedAt && codexUpstream.closedAt - removedAt <= limitMs,
      `Codex's stream was cut off ${codexUpstream?.closedAt ? codexUpstream.closedAt - removedAt : "?"} ms after the removal; Codex stopped (exit ${codexEnd.code}) and showed: ${codexSaid.at(-1)?.trim()}`,
      () => showRun(codexEnd),
    );
    log = await relayLog();
    const killed = log.find((e) => e.name === agent && e.reason === "killed: access revoked");
    check(killed && (killed.costUsd ?? 0) > 0, `the relay log says "killed: access revoked" and charged what was used (${usd(killed?.costUsd ?? 0)})`);
    const refusedAfter = log.filter((e) => e.name === agent && !e.allowed && e.ts >= removedAt && /^access revoked/.test(e.reason ?? ""));
    note(`after the kill Codex tried ${refusedAfter.length} more time${refusedAfter.length === 1 ? "" : "s"}; the relay answered 403 "access revoked" each time`);
    const next = await getJson<{ error?: string; reason?: string }>(`${RELAY}/api/relay/codex/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5", input: "hi", max_output_tokens: 256 }),
    });
    check(
      next.status === 403 && next.json?.error === "access revoked" && next.json.reason === `access revoked: ${derek} was removed or expired. Run ./relay login.`,
      `Codex's next call is refused: 403 "${next.json?.reason}"`,
      next.text,
    );
    const deadExec = await cli(["exec", "--as", "research", "hi"]);
    check(
      deadExec.code === 1 && deadExec.stderr.trim() === `access revoked: ${derek} was removed or expired. Run ./relay login.`,
      `the subagents are dead too (./relay exec --as research): ${deadExec.stderr.trim()}`,
      () => showRun(deadExec),
    );
    // The relay reuses its walk of the tree for a few seconds.
    await sleep(Math.max(0, removedAt + TREE_TTL_MS + 500 - Date.now()));
    const relogin = await cli(["login"]);
    const reloginAt = Date.now();
    check(relogin.code === 1 && relogin.stderr.includes(`No ENS name found for ${userAddress}`), `./relay login now fails: ${relogin.stderr.trim()}`, () => showRun(relogin));

    // 10 -----------------------------------------------------------------------------------------
    section("10. npm run demo:reset, then derek again");
    const oldDerek = p.levels[3];
    const extra = privateKeyToAccount(generatePrivateKey()).address;
    await addMember("extra", extra, { keys: ["codex"], caps: { codex: 1 }, period: "month" });
    ok(`the admin also added extra.${dev} (so the reset has a live member to remove)`);
    const reset = await run(NPM, ["run", "-s", "demo:reset", "--", "--yes"], {
      env: { ADMIN_PRIVATE_KEY: ADMIN_KEY, ORG_LABEL: org, RELAY_URL: RELAY, RELAY_ADMIN_TOKEN: ADMIN_TOKEN, RELAY_HOME: home, RELAY_RPC_URL: RPC },
      timeoutMs: 5 * 60_000,
    });
    const cleared = reset.stdout.match(/cleared spend for \d+ removed names?: (.*)/)?.[1]?.split(", ") ?? [];
    check(reset.code === 0 && reset.stdout.includes(`removed extra.${dev}`) && /keeping launch/.test(reset.stdout), "demo:reset removed extra and kept the launch squad", () => showRun(reset));
    check(
      [derek, agent, research, image].every((n) => cleared.includes(n)),
      `the relay cleared the meters of removed names: ${cleared.map(short).join(", ")}`,
      () => showRun(reset),
    );
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, "relay.json"), "utf8")) as { spend: Record<string, number>; counts?: Record<string, number> };
    const nodes = [derek, agent, research, image].map((n) => namehash(n).toLowerCase());
    const leftover = [...Object.keys(store.spend), ...Object.keys(store.counts ?? {})].filter((k) => nodes.some((n) => k.toLowerCase().startsWith(n)));
    check(leftover.length === 0, "relay.json has no spend or counts left for them", leftover.join("\n"));
    check(!fs.existsSync(home), "RELAY_HOME was deleted");
    const derekGone = await readEntry(pub, devRegistry, "derek");
    check(!derekGone.registered, "derek is not registered");

    const init2 = await cli(["init", "--relay", RELAY, "--rpc", RPC]);
    const user2 = init2.stdout.trim().split("\n")[0] as Address;
    check(init2.code === 0 && isAddress(user2), `./relay init again → ${user2}`, () => showRun(init2));
    await addMember("derek", user2, derekBundle);
    const funded2 = await fund(derek);
    check(funded2.json?.funded === true, `the admin re-added derek and the funder topped up the new wallet`, funded2.text);
    await sleep(Math.max(0, reloginAt + TREE_TTL_MS + 500 - Date.now()));
    const login2 = await cli(["login"]);
    check(login2.code === 0 && login2.stderr.includes(`Session ready: ${agent}`), `./relay login works again (${Math.round(login2.ms / 1000)} s)`, () => showRun(login2));
    p = await policy(agent, "codex");
    const fresh = p.levels.slice(3);
    check(
      p.allowed && fresh.every((l) => (l.spent.codex ?? 0) === 0 && (l.used?.["openai-images"] ?? 0) === 0) && fresh[0].resource !== oldDerek.resource,
      `derek and ${short(agent)} start at $0 and 0 images (derek has a new resource)`,
      () => JSON.stringify(fresh, null, 1).slice(0, 1500),
    );

    const allSeen = fake.seen;
    check(
      allSeen.every((s) => !s.hasToken) && allSeen.filter((s) => s.kind !== "other").every((s) => s.authorization === `Bearer ${FAKE_OPENAI_KEY}`),
      `over the whole run the fake OpenAI saw ${allSeen.length} requests, every one with the relay's key and none with a kr1 token`,
    );
    passed = true;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

main()
  .then(() => {
    console.log(`\nAll ${checks} checks passed`);
    process.exit(0);
  })
  .catch((err) => {
    const detail = err instanceof Failure ? err.detail : err instanceof Error ? err.stack : undefined;
    console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}`);
    if (detail) console.log(indent(detail));
    console.log(`\nStopped after ${checks} passing checks`);
    process.exit(1);
  });
