// MultiBaas client against a fake HTTP server: envelope unwrapping, errors without the key,
// 404 -> null, idempotent upload, call kinds, local path validation, timeouts, and signMbTx.

import assert from "node:assert/strict";
import test from "node:test";

import { type Hex, getAddress, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { fakeUpstream } from "../relay/testkit";
import { MultiBaasError, apiBase, multibaas, multibaasFromConfig, quantity, signMbTx, summarizeReceipt } from "./client";
import type { MbTx } from "./types";

const KEY = "mb-secret-key-123";
const ok = (result: unknown) => JSON.stringify({ status: 200, message: "success", result });
const fail = (status: number, message: string) => JSON.stringify({ status, message });

type Route = (method: string, url: string, body: string) => [number, string] | undefined;

async function server(route: Route) {
  return fakeUpstream((req, res, body) => {
    const hit = route(req.method!, req.url!, body) ?? [404, fail(404, "not found")];
    res.writeHead(hit[0], { "content-type": "application/json" });
    res.end(hit[1]);
  });
}

test("apiBase normalises the deployment URL", () => {
  assert.equal(apiBase("https://abc.multibaas.com"), "https://abc.multibaas.com/api/v0");
  assert.equal(apiBase("https://abc.multibaas.com/api/v0/"), "https://abc.multibaas.com/api/v0");
  assert.throws(() => apiBase("ftp://x"));
  assert.throws(() => apiBase("https://u:p@x.com"));
});

test("status: Bearer key, api/v0 path, envelope unwrapped", async () => {
  const up = await server((m, u) => (m === "GET" && u === "/api/v0/chains/ethereum/status" ? [200, ok({ chainID: 11155111, networkID: 11155111, blockNumber: 42, version: "x" })] : undefined));
  try {
    const mb = multibaas({ url: `${up.url}/api/v0/`, key: KEY });
    const s = await mb.status();
    assert.equal(s.chainID, 11155111);
    assert.equal(up.last().headers.authorization, `Bearer ${KEY}`);
  } finally {
    up.close();
  }
});

test("errors carry status and path, never the key", async () => {
  const up = await server((_m, u) =>
    u.includes("status") ? [401, fail(401, `invalid token ${KEY}`)] : u.includes("plan") ? [200, "<html>oops</html>"] : [200, JSON.stringify({ status: 200, message: "nope" })],
  );
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    const e = await mb.status().catch((x) => x);
    assert.ok(e instanceof MultiBaasError);
    assert.equal(e.status, 401);
    assert.equal(e.kind, "http");
    assert.equal(e.path, "/chains/ethereum/status");
    assert.ok(!e.message.includes(KEY), e.message);
    assert.match(e.message, /\[redacted\]/);
    await assert.rejects(mb.plan(), (x: MultiBaasError) => x.status === 200 && /unexpected answer/.test(x.message));
    await assert.rejects(mb.listContracts(), (x: MultiBaasError) => /nope/.test(x.message));
  } finally {
    up.close();
  }
});

test("missing URL or key fails before any request", async () => {
  await assert.rejects(multibaas({ url: () => null, key: KEY }).status(), (e: MultiBaasError) => e.kind === "invalid" && /MULTIBAAS_URL/.test(e.message));
  await assert.rejects(multibaas({ url: "https://x.multibaas.com", key: () => null }).status(), (e: MultiBaasError) => /MULTIBAAS_API_KEY/.test(e.message));
});

test("createContract is idempotent: create on 404, skip same bin, refuse different bin", async () => {
  let stored: { bin: string; rawAbi: string } | null = null;
  const up = await server((m, u, body) => {
    if (m === "GET" && u === "/api/v0/contracts/relay-token/1.0") return stored ? [200, ok({ label: "relay-token", contractName: "T", version: "1.0", ...stored })] : [404, fail(404, "Unknown contract")];
    if (m === "POST" && u === "/api/v0/contracts/relay-token") {
      stored = JSON.parse(body);
      return [200, JSON.stringify({ status: 200, message: "success" })];
    }
  });
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    assert.equal(await mb.getContract("relay-token", "1.0"), null);
    const abi = [{ type: "function", name: "x", inputs: [], outputs: [], stateMutability: "view" }];
    assert.equal(await mb.createContract("relay-token", { contractName: "T", version: "1.0", rawAbi: abi, bin: "0xABCD" }), "created");
    const posted = JSON.parse(up.seen.find((s) => s.method === "POST")!.body);
    assert.equal(posted.rawAbi, JSON.stringify(abi), "rawAbi is sent as a JSON string");
    assert.equal(posted.bin, "0xabcd", "bin is lowercased");
    assert.equal(posted.label, "relay-token");
    const posts = () => up.seen.filter((s) => s.method === "POST").length;
    assert.equal(await mb.createContract("relay-token", { contractName: "T", version: "1.0", rawAbi: abi, bin: "0xabcd" }), "exists");
    assert.equal(posts(), 1);
    await assert.rejects(mb.createContract("relay-token", { contractName: "T", version: "1.0", rawAbi: abi, bin: "0x1234" }), (e: MultiBaasError) => e.status === 409);
    assert.equal(posts(), 1);
  } finally {
    up.close();
  }
});

test("call: reads and writes by kind, as_strings by default, args default to []", async () => {
  const tx: MbTx = { from: "0x00000000000000000000000000000000000000aa", to: "0x00000000000000000000000000000000000000bb", nonce: 3, gas: 50000, value: "0", data: "0x1234", type: 2, gasFeeCap: "100", gasTipCap: "1" };
  const up = await server((m, u) => {
    if (m !== "POST") return;
    if (u === "/api/v0/chains/ethereum/addresses/relay-vault/contracts/relay-vault/methods/paused") return [200, ok({ kind: "MethodCallResponse", output: false })];
    if (u === "/api/v0/chains/ethereum/addresses/relay-vault/contracts/relay-vault/methods/pay") return [200, ok({ kind: "TransactionToSignResponse", tx, submitted: false })];
    if (u.endsWith("/methods/weird")) return [200, ok({ kind: "Other" })];
  });
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    assert.equal(await mb.read("relay-vault", "relay-vault", "paused"), false);
    assert.deepEqual(JSON.parse(up.last().body), { formatInts: "as_strings", args: [] });
    const prepared = await mb.prepare("relay-vault", "relay-vault", "pay", { args: ["0x00000000000000000000000000000000000000cc", "3", "0x" + "00".repeat(32)], from: tx.from });
    assert.deepEqual(prepared, tx);
    assert.equal(JSON.parse(up.last().body).from, tx.from);
    await assert.rejects(mb.read("relay-vault", "relay-vault", "pay"), /not a view function/);
    await assert.rejects(mb.prepare("relay-vault", "relay-vault", "paused", { from: tx.from }), /did not compose/);
    await assert.rejects(mb.call("relay-vault", "relay-vault", "weird"), /unexpected call result/);
  } finally {
    up.close();
  }
});

test("paths are validated locally (no request for a bad label, alias, method or hash)", async () => {
  const up = await server(() => [200, ok({})]);
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    await assert.rejects(mb.getContract("../plan"), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.getContract("Relay"), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.getContract("relay-token", "1.0/../x"), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.call("sodalabs.eth", "relay-vault", "pay"), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.call("relay-vault", "relay-vault", "pay/../../x"), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.receipt("0x1234" as Hex), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.link("relay-vault", { label: "relay-vault", startingBlock: "soon" }), (e: MultiBaasError) => e.kind === "invalid");
    await assert.rejects(mb.block(-1), (e: MultiBaasError) => e.kind === "invalid");
    assert.equal(up.seen.length, 0);
  } finally {
    up.close();
  }
});

test("addresses: checksummed in the path, alias/link bodies, include=balance, 404 -> null", async () => {
  const a = "0x000000000000000000000000000000000000dead";
  const A = "0x000000000000000000000000000000000000dEaD";
  const up = await server((m, u, body) => {
    if (m === "GET" && u === `/api/v0/chains/ethereum/addresses/${A}?include=balance`) return [200, ok({ alias: "", address: A, chain: "ethereum", contracts: [], balance: "30000000000000000" })];
    if (m === "GET" && u === "/api/v0/chains/ethereum/addresses/relay-token") return [404, fail(404, "Unknown address or name")];
    if (m === "POST" && u === "/api/v0/chains/ethereum/addresses") return [201, ok({ ...JSON.parse(body), chain: "ethereum", contracts: [] })];
    if (m === "POST" && u === "/api/v0/chains/ethereum/addresses/relay-token/contracts") return [200, ok({ alias: "relay-token", address: A, chain: "ethereum", contracts: [{ label: "relay-token", name: "T", version: "1.0" }] })];
    if (m === "GET" && u === "/api/v0/chains/ethereum/addresses/relay-token/contracts/relay-token/status")
      return [200, ok({ isProcessingPastLogs: false, latestBlockNumber: 10, latestBlockHash: "0x", startBlockNumber: 9, startBlockHash: "0x", updatedAt: "" })];
  });
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    assert.equal(await mb.balance(a), 30000000000000000n);
    assert.equal(await mb.getAddress("relay-token"), null);
    const set = await mb.setAlias(a, "relay-token");
    assert.equal(set.alias, "relay-token");
    assert.deepEqual(JSON.parse(up.last().body), { address: A, alias: "relay-token" });
    await mb.link("relay-token", { label: "relay-token", version: "1.0", startingBlock: "latest" });
    assert.deepEqual(JSON.parse(up.last().body), { label: "relay-token", version: "1.0", startingBlock: "latest" });
    assert.equal((await mb.indexingStatus("relay-token", "relay-token"))?.isProcessingPastLogs, false);
  } finally {
    up.close();
  }
});

test("listAddresses and unlink", async () => {
  const E = "0x00000000000000000000000000000000000000E1";
  const up = await server((m, u) => {
    if (m === "GET" && u === "/api/v0/chains/ethereum/addresses")
      return [200, ok([{ alias: "relay-escrow-1", address: E, chain: "ethereum", contracts: [{ label: "relay-escrow", name: "SimpleEscrow", version: "1.0" }] }])];
    if (m === "DELETE" && u === "/api/v0/chains/ethereum/addresses/relay-escrow-1/contracts/relay-escrow") return [200, ok(null)];
  });
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    const list = await mb.listAddresses();
    assert.equal(list[0].alias, "relay-escrow-1");
    await mb.unlink("relay-escrow-1", "relay-escrow");
    assert.equal(up.last().method, "DELETE");
    await assert.rejects(mb.unlink("relay-escrow-2", "relay-escrow"), (x: MultiBaasError) => x.status === 404);
    await assert.rejects(mb.unlink("bad alias!", "relay-escrow"), (x: MultiBaasError) => x.kind === "invalid");
  } finally {
    up.close();
  }
});

test("deploy, submit, tx, receipt (404 = pending), block and events", async () => {
  const hash = `0x${"ab".repeat(32)}` as Hex;
  const up = await server((m, u, body) => {
    if (m === "POST" && u === "/api/v0/contracts/relay-escrow/1.0/deploy")
      return [200, ok({ tx: { from: "0x00000000000000000000000000000000000000aa", to: null, nonce: 1, gas: 900000, value: "0", data: "0x60", type: 2 }, deployAt: "0x00000000000000000000000000000000000000ee", submitted: false })];
    if (m === "POST" && u === "/api/v0/chains/ethereum/transactions/submit") return [200, ok({ tx: { hash: hash.toUpperCase().replace("0X", "0x"), signed: JSON.parse(body).signedTx } })];
    if (m === "GET" && u === `/api/v0/chains/ethereum/transactions/receipt/${hash}`) return [404, fail(404, "Issue retrieving transaction")];
    if (m === "GET" && u === `/api/v0/chains/ethereum/transactions/${hash}`) return [200, ok({ data: { hash }, isPending: true, from: "0x00000000000000000000000000000000000000aa" })];
    if (m === "GET" && u === "/api/v0/chains/ethereum/blocks/12") return [200, ok({ hash, number: "12", timestamp: 1, parentHash: hash })];
    if (m === "GET" && u.startsWith("/api/v0/events?")) return [200, ok([])];
  });
  try {
    const mb = multibaas({ url: up.url, key: KEY });
    const d = await mb.deploy("relay-escrow", "1.0", { args: ["0x1"], from: "0x00000000000000000000000000000000000000aa" });
    assert.equal(d.deployAt, "0x00000000000000000000000000000000000000ee");
    const s = await mb.submit("0x02f8");
    assert.equal(s.hash, hash, "hash is lowercased");
    assert.equal(JSON.parse(up.last().body).signedTx, "0x02f8");
    assert.equal(await mb.receipt(hash), null);
    assert.equal((await mb.tx(hash))?.isPending, true);
    assert.equal((await mb.block(12)).number, "12");
    await mb.events({ contract_address: "0x00000000000000000000000000000000000000ee", event_signature: "Paid(address,uint256,bytes32,address)", limit: 50, offset: 0 });
    const q = new URL(up.last().url, "http://x").searchParams;
    assert.equal(q.get("event_signature"), "Paid(address,uint256,bytes32,address)");
    assert.equal(q.get("limit"), "50");
    assert.equal(q.get("offset"), "0");
  } finally {
    up.close();
  }
});

test("timeout and network failures are kinds of their own", async () => {
  const up = await fakeUpstream(() => {
    /* never answers */
  });
  try {
    await assert.rejects(multibaas({ url: up.url, key: KEY, timeoutMs: 150 }).status(), (e: MultiBaasError) => e.kind === "timeout" && e.status === 0);
  } finally {
    up.close();
  }
  await assert.rejects(multibaas({ url: "http://127.0.0.1:1", key: KEY }).status(), (e: MultiBaasError) => e.kind === "network" && !e.message.includes(KEY));
});

test("multibaasFromConfig reads URL and key per call", async () => {
  const up = await server(() => [200, ok({ chainID: 11155111, networkID: 1, blockNumber: 1, version: "" })]);
  const saved = { url: process.env.MULTIBAAS_URL, key: process.env.MULTIBAAS_API_KEY };
  try {
    delete process.env.MULTIBAAS_URL;
    delete process.env.MULTIBAAS_API_KEY;
    const mb = multibaasFromConfig();
    await assert.rejects(mb.status(), (e: MultiBaasError) => e.kind === "invalid");
    process.env.MULTIBAAS_URL = up.url;
    process.env.MULTIBAAS_API_KEY = "later-key";
    assert.equal((await mb.status()).chainID, 11155111);
    assert.equal(up.last().headers.authorization, "Bearer later-key");
  } finally {
    for (const [k, v] of [["MULTIBAAS_URL", saved.url], ["MULTIBAAS_API_KEY", saved.key]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    up.close();
  }
});

test("summarizeReceipt and quantity decode MultiBaas's number formats", () => {
  const r = summarizeReceipt({
    data: { status: "0x1", blockNumber: "0x10", blockHash: `0x${"AA".repeat(32)}` as Hex, transactionHash: `0x${"BB".repeat(32)}` as Hex, contractAddress: "0x0000000000000000000000000000000000000000" },
  });
  assert.deepEqual(r, { hash: `0x${"bb".repeat(32)}`, blockNumber: 16, blockHash: `0x${"aa".repeat(32)}`, status: "success", contractAddress: null });
  const d = summarizeReceipt({ data: { status: "0x0", blockNumber: "0x1", blockHash: "0x00", transactionHash: "0x01", contractAddress: "0x00000000000000000000000000000000000000ee" } });
  assert.equal(d.status, "reverted");
  assert.equal(d.contractAddress, getAddress("0x00000000000000000000000000000000000000ee"));
  assert.equal(quantity("12"), 12);
  assert.equal(quantity(7), 7);
  assert.throws(() => quantity("-1"));
});

test("signMbTx: 1559 and legacy mapping, hash = keccak(serialized), from must match", async () => {
  const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const base: MbTx = { from: account.address, to: "0x00000000000000000000000000000000000000bb", nonce: 5, gas: 60000, value: "0", data: "0xabcd", type: 2, gasFeeCap: "3000000000", gasTipCap: "1000000000", hash: "0xdeadbeef" };
  const s = await signMbTx(account, base, 11155111);
  assert.equal(s.hash, keccak256(s.serialized));
  const p = parseTransaction(s.serialized);
  assert.equal(p.type, "eip1559");
  assert.equal(p.chainId, 11155111);
  assert.equal(p.nonce, 5);
  assert.equal(p.gas, 60000n);
  assert.equal(p.maxFeePerGas, 3000000000n);
  assert.equal(p.maxPriorityFeePerGas, 1000000000n);
  assert.equal(p.data, "0xabcd");
  assert.equal(await recoverTransactionAddress({ serializedTransaction: s.serialized as never }), account.address);

  const legacy = await signMbTx(account, { ...base, type: 0, gasPrice: "2000000000", gasFeeCap: undefined, gasTipCap: undefined, data: "", to: null }, 11155111);
  const l = parseTransaction(legacy.serialized);
  assert.equal(l.type, "legacy");
  assert.equal(l.gasPrice, 2000000000n);
  assert.equal(l.to, undefined, "a deploy has no to");

  await assert.rejects(signMbTx(account, { ...base, from: "0x00000000000000000000000000000000000000aa" }, 11155111), /not from this signer/);
  await assert.rejects(signMbTx(account, { ...base, gasFeeCap: undefined }, 11155111), /gasFeeCap/);
  await assert.rejects(signMbTx(account, { ...base, value: "1.5" }, 11155111), /value/);
  await assert.rejects(signMbTx(account, { ...base, type: 4 }, 11155111), /unsupported/);
  await assert.rejects(signMbTx(account, base, 0), /chain id/);
});
