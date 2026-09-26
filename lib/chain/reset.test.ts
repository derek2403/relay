// The chain half of the admin round reset (POST /api/relay/admin/reset {"chain": true}).

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import type { Address, Hex } from "viem";

import { namehash } from "../ens/names";
import { listIncidents, type ApprovalsDeps } from "../relay/approvals/api";
import { keyOf } from "../relay/approvals/incidents";
import { ApprovalsStore, type Incident, type StoredOverlay } from "../relay/approvals/store";
import type { ChainReader } from "../relay/ens";
import { MemoryChain, bundle, level, tempDir } from "../relay/testkit";
import type { ChainDeps } from "./executor";
import { type LedgerLevel, ledgerKey } from "./ledger";
import { type NewProposal, type Proposal, type ProposalState, createProposal, transition } from "./proposals";
import { resetChainRound, resetLedger } from "./reset";
import { handleListProposals } from "./service";
import { ChainStore, chainStore, resetChainStores } from "./store";

const ROOT = "sodalabs.eth";
const CLOUDOPS = `cloudops.dev.${ROOT}`;
const DEREK = `derek.${CLOUDOPS}`;
const DEREK_CODEX = `codex.${DEREK}`;
const EMMA = `emma.${CLOUDOPS}`;
const EMMA_CODEX = `codex.${EMMA}`;
const ADMIN: Address = "0x00000000000000000000000000000000000000AD";
const OWNER: Address = "0x4444444444444444444444444444444444444444";
const TOKEN = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;
const NOW = new Date("2026-09-15T12:00:00Z");
const T0 = Math.floor(NOW.getTime() / 1000);

const chainOf = () =>
  new MemoryChain([
    level(ROOT, ADMIN, bundle("codex")),
    level(`dev.${ROOT}`, ADMIN, bundle("codex")),
    level(CLOUDOPS, ADMIN, bundle("codex")),
    level(DEREK, OWNER, bundle("codex")),
    level(DEREK_CODEX, OWNER, bundle("codex")),
    level(EMMA, OWNER, bundle("codex")),
    level(EMMA_CODEX, OWNER, bundle("codex")),
  ]);

const input = (agent: string, requestId: string): NewProposal => ({
  requestId,
  agent: { name: agent, node: namehash(agent), resource: "7", owner: OWNER },
  op: "call",
  network: "sepolia",
  target: { kind: "vault", address: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", label: "relay-vault" },
  method: "pay",
  args: ["0x1111111111111111111111111111111111111111", "3000000000000000000", `0x${"00".repeat(32)}`],
  display: { summary: `pay 3 STD (${requestId})` },
  tx: { from: "0x5555555555555555555555555555555555555555", to: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB", data: "0xabcdef", value: "0", gas: "90000", type: 2 },
  gasEstimate: "80000",
  grantId: `0x${"12".repeat(32)}`,
  approval: { required: true, rule: "always" },
});

/** A proposal walked through `path` (each a legal transition). */
function proposal(store: ChainStore, agent: string, requestId: string, states: ProposalState[], patch: Partial<Proposal> = {}): Proposal {
  let p = createProposal(input(agent, requestId), T0);
  for (const s of states) p = transition(p, s, `to ${s}`, T0);
  p = { ...p, ...patch };
  store.update((d) => {
    d.proposals[p.id] = p;
  });
  return p;
}

const levelOf = (name: string, limit: bigint): LedgerLevel => ({ name, node: namehash(name) as Hex, resource: "7", limit: { base: limit, period: "month" } });
const CLOUDOPS_LEVEL = levelOf(CLOUDOPS, 40n * E18);
const bucket = (name: string) => ledgerKey(namehash(name) as Hex, "7", TOKEN, "2026-09");

function incident(id: string, name: string, state: Incident["state"]): Incident {
  return {
    id,
    root: ROOT,
    revision: 1,
    state,
    key: keyOf(name, "7"),
    subject: { name, node: namehash(name) as Hex, resource: "7", owner: OWNER, parent: name.slice(name.indexOf(".") + 1) },
    trigger: { source: "renewal-request", requestedBy: name, at: T0 },
    events: [],
    openedAt: T0,
    reviewBy: T0 + 72 * 3600,
  } as unknown as Incident;
}

const overlay = (id: string, name: string): StoredOverlay => ({
  id,
  key: keyOf(name, "7"),
  name,
  incidentId: "inc_x",
  bundle: null,
  chain: null,
  notAfter: T0 + 3600,
  bucket: `approval:${id}`,
  approver: ADMIN,
  digest: `0x${"ab".repeat(32)}`,
  at: T0,
});

function world() {
  const dir = tempDir("relay-round-");
  const store = new ChainStore(path.join(dir, "chain.json"));
  const approvals = new ApprovalsStore(path.join(dir, "approvals.json"));
  const chain = chainOf();
  return { dir, store, approvals, chain };
}

test("round reset: archives settled and removed-name items, keeps in-flight ones, resets the ledger", async () => {
  const { store, approvals, chain } = world();
  const ledger = store.ledger(TOKEN);

  const gonePending = proposal(store, DEREK_CODEX, "a", []); // awaiting-approval, Derek removed
  const inFlight = proposal(store, DEREK_CODEX, "b", ["approved", "submitting", "submitted"]);
  const confirmed = proposal(store, EMMA_CODEX, "c", ["approved", "submitting", "submitted", "included", "confirmed"]);
  const livePending = proposal(store, EMMA_CODEX, "d", []);
  const failed = proposal(store, EMMA_CODEX, "e", ["approved", "submitting", "failed"]);
  const midSubmit = proposal(store, EMMA_CODEX, "f", ["approved"]);
  const derekLevels = [CLOUDOPS_LEVEL, levelOf(DEREK_CODEX, 10n * E18)];
  const emmaLevels = [CLOUDOPS_LEVEL, levelOf(EMMA_CODEX, 40n * E18)];

  // Earlier rounds used 30 of cloudops' 40 STD this month.
  assert.ok(ledger.reserve(emmaLevels, 30n * E18, `rsv_${confirmed.id}_1`, NOW).ok);
  assert.ok(ledger.commit(`rsv_${confirmed.id}_1`));
  // In flight: 3 STD for the submitted payment (recorded on the proposal).
  assert.ok(ledger.reserve(derekLevels, 3n * E18, `rsv_${inFlight.id}_1`, NOW).ok);
  store.updateProposal(inFlight.id, (p) => ({ ...p, reservationId: `rsv_${inFlight.id}_1` }));
  // Stale: a failed payment whose hold was never released.
  assert.ok(ledger.reserve(emmaLevels, 2n * E18, `rsv_${failed.id}_1`, NOW).ok);
  // A submit preparing right now: reserved before the proposal records the id.
  assert.ok(ledger.reserve(emmaLevels, 1n * E18, `rsv_${midSubmit.id}_1`, NOW).ok);
  assert.equal(ledger.reserve(emmaLevels, 5n * E18, "over", NOW).ok, false, "cloudops is at 36 of 40");

  store.addRun(EMMA_CODEX, { id: "run_1", at: T0, task: "review", plan: null, results: [], report: null });
  store.addRun(DEREK_CODEX, { id: "run_2", at: T0, task: "pay", plan: null, results: [], report: null });
  const base = { proposalId: "prp_x", admin: OWNER, payee: OWNER, amount: "5", txHash: `0x${"01".repeat(32)}` as Hex, block: 1 };
  store.addEscrow({ ...base, address: "0x00000000000000000000000000000000000000E1", deployedBy: DEREK_CODEX });
  store.addEscrow({ ...base, address: "0x00000000000000000000000000000000000000E2", deployedBy: EMMA_CODEX });

  approvals.commit((d) => {
    d.incidents.inc_derek = incident("inc_derek", DEREK, "open");
    d.suspensions[keyOf(DEREK, "7")] = { incidentId: "inc_derek", name: DEREK, since: T0, permanent: false };
    d.incidents.inc_done = incident("inc_done", EMMA_CODEX, "resolved:approved-narrower");
    d.incidents.inc_emma = incident("inc_emma", EMMA_CODEX, "open");
    d.suspensions[keyOf(EMMA_CODEX, "7")] = { incidentId: "inc_emma", name: EMMA_CODEX, since: T0, permanent: false };
    d.overlays.ovl_derek = overlay("ovl_derek", DEREK_CODEX);
    d.overlays.ovl_emma = overlay("ovl_emma", EMMA_CODEX);
  });

  chain.remove(DEREK);
  const r = await resetChainRound({ chain: store, approvals, reader: chain, root: ROOT, nowSec: T0 + 60 });

  // Proposals: settled ones and the removed name's open one are archived; in-flight and live open ones stay.
  const p = (id: string) => store.proposal(id)!;
  assert.equal(p(gonePending.id).state, "expired");
  assert.equal(p(gonePending.id).archivedAt, T0 + 60);
  assert.ok(p(confirmed.id).archivedAt && p(failed.id).archivedAt);
  assert.equal(p(confirmed.id).state, "confirmed", "a settled proposal keeps its state");
  assert.equal(p(inFlight.id).archivedAt, undefined);
  assert.equal(p(inFlight.id).state, "submitted");
  assert.equal(p(livePending.id).archivedAt, undefined);
  assert.equal(p(livePending.id).state, "awaiting-approval");
  assert.equal(p(midSubmit.id).state, "approved");
  assert.deepEqual(r.expired.proposals, [gonePending.id]);
  assert.deepEqual(r.inFlight, [inFlight.id]);
  assert.equal(r.archived.proposals, 3);
  assert.equal(store.proposals().length, 6, "nothing is deleted");

  // Runs and escrows.
  assert.equal(r.archived.runs, 2);
  assert.deepEqual(store.runs(EMMA_CODEX), []);
  assert.equal(store.runs(EMMA_CODEX, { archived: true }).length, 1);
  assert.equal(r.archived.escrows, 1);
  assert.ok(store.escrows().find((e) => e.deployedBy === DEREK_CODEX)!.archivedAt);
  assert.equal(store.escrows().find((e) => e.deployedBy === EMMA_CODEX)!.archivedAt, undefined);

  // Ledger: spent is back to 0; only the in-flight (and mid-submit) holds remain reserved.
  const d = store.snapshot().ledger;
  assert.deepEqual(d.buckets[bucket(CLOUDOPS)], { spent: "0", reserved: (4n * E18).toString() });
  assert.deepEqual(d.buckets[bucket(DEREK_CODEX)], { spent: "0", reserved: (3n * E18).toString() });
  assert.deepEqual(d.buckets[bucket(EMMA_CODEX)], { spent: "0", reserved: (1n * E18).toString() });
  assert.deepEqual(r.ledger.held.sort(), [`rsv_${inFlight.id}_1`, `rsv_${midSubmit.id}_1`].sort());
  assert.deepEqual(r.ledger.released, [`rsv_${failed.id}_1`]);
  assert.equal(d.reservations[`rsv_${inFlight.id}_1`].state, "reserved", "in-flight reservation untouched");
  assert.equal(d.reservations[`rsv_${confirmed.id}_1`].state, "committed");
  assert.equal(d.reservations[`rsv_${failed.id}_1`].state, "released");
  // The tracker can still settle the in-flight payment, and the new round has cloudops' allowance back.
  assert.ok(ledger.commit(`rsv_${inFlight.id}_1`));
  assert.deepEqual(store.snapshot().ledger.buckets[bucket(CLOUDOPS)], { spent: (3n * E18).toString(), reserved: (1n * E18).toString() });
  assert.ok(ledger.reserve(emmaLevels, 36n * E18, "round-2", NOW).ok);
  assert.ok(ledger.release(`rsv_${failed.id}_1`), "releasing the stale hold again is a no-op");

  // Approvals: the removed name's incident expires and is archived; the resolved one is archived; the live open one stays.
  const inc = approvals.data.incidents;
  assert.equal(inc.inc_derek.state, "expired");
  assert.equal(inc.inc_derek.archivedAt, T0 + 60);
  assert.equal(inc.inc_derek.revision, 2, "outstanding challenges no longer match");
  assert.equal(inc.inc_done.state, "resolved:approved-narrower");
  assert.ok(inc.inc_done.archivedAt);
  assert.equal(inc.inc_emma.archivedAt, undefined);
  assert.deepEqual(r.expired.incidents, ["inc_derek"]);
  assert.deepEqual(r.lifted.suspensions, [DEREK]);
  assert.deepEqual(Object.keys(approvals.data.suspensions), [keyOf(EMMA_CODEX, "7")], "a live name stays paused");
  assert.deepEqual(Object.keys(approvals.data.overlays), ["ovl_emma"]);
  assert.equal(approvals.data.audit.at(-1)?.kind, "round-reset");
  assert.deepEqual(r.skipped, []);

  // A second reset archives nothing new and never rewrites archivedAt.
  const again = await resetChainRound({ chain: store, approvals, reader: chain, root: ROOT, nowSec: T0 + 120 });
  assert.equal(again.archived.proposals, 0);
  assert.equal(again.archived.incidents, 0);
  assert.equal(store.proposal(gonePending.id)!.archivedAt, T0 + 60, "archivedAt is not rewritten");
});

test("round reset: a re-registered name (new resource) counts as removed for its old key", async () => {
  const { store, approvals, chain } = world();
  const old = proposal(store, DEREK_CODEX, "a", []);
  approvals.commit((d) => {
    d.suspensions[keyOf(DEREK, "7")] = { incidentId: "inc_1", name: DEREK, since: T0, permanent: true };
  });
  const levels = chain.levels;
  const i = levels.findIndex((l) => l.name === DEREK);
  levels[i] = { ...levels[i], resource: "8" };
  const j = levels.findIndex((l) => l.name === DEREK_CODEX);
  levels[j] = { ...levels[j], resource: "8" };
  const r = await resetChainRound({ chain: store, approvals, reader: chain, root: ROOT, nowSec: T0 });
  assert.equal(store.proposal(old.id)!.state, "expired");
  assert.deepEqual(r.lifted.suspensions, [DEREK]);
});

test("round reset: a name ENS can't read is left alone (reported), settled items are still archived", async () => {
  const { store, approvals, chain } = world();
  const open = proposal(store, DEREK_CODEX, "a", []);
  const done = proposal(store, DEREK_CODEX, "b", ["rejected"]);
  approvals.commit((d) => {
    d.suspensions[keyOf(DEREK, "7")] = { incidentId: "inc_1", name: DEREK, since: T0, permanent: false };
  });
  chain.remove(DEREK);
  const flaky: ChainReader = {
    readLevels: async () => {
      throw new Error("rpc down");
    },
  };
  const r = await resetChainRound({ chain: store, approvals, reader: flaky, root: ROOT, nowSec: T0 });
  assert.equal(store.proposal(open.id)!.state, "awaiting-approval");
  assert.equal(store.proposal(open.id)!.archivedAt, undefined);
  assert.ok(store.proposal(done.id)!.archivedAt);
  assert.equal(Object.keys(approvals.data.suspensions).length, 1, "not lifted without proof the name is gone");
  assert.deepEqual(r.skipped.map((s) => s.name).sort(), [DEREK, DEREK_CODEX].sort());
});

test("round reset: a broken store refuses and changes nothing", async () => {
  const { dir, store, chain } = world();
  const fs = await import("node:fs");
  fs.writeFileSync(path.join(dir, "approvals.json"), "{nope");
  const broken = new ApprovalsStore(path.join(dir, "approvals.json"));
  const p = proposal(store, EMMA_CODEX, "a", ["rejected"]);
  await assert.rejects(resetChainRound({ chain: store, approvals: broken, reader: chain, root: ROOT }), /damaged/);
  assert.equal(store.proposal(p.id)!.archivedAt, undefined);
});

test("resetLedger: a reservation with no matching proposal is held (never guessed away)", () => {
  const key = bucket(CLOUDOPS);
  const out = resetLedger(
    {
      buckets: { [key]: { spent: (9n * E18).toString(), reserved: (2n * E18).toString() } },
      reservations: { mystery: { amount: (2n * E18).toString(), keys: [key], state: "reserved", at: T0, names: [CLOUDOPS] } },
    },
    {},
  );
  assert.deepEqual(out.data.buckets[key], { spent: "0", reserved: (2n * E18).toString() });
  assert.deepEqual(out.held, ["mystery"]);
  assert.equal(out.reset, 1);
});

test("list endpoints leave archived items out unless ?archived=1", async () => {
  const { store, approvals } = world();
  const kept = proposal(store, EMMA_CODEX, "a", []);
  const old = proposal(store, EMMA_CODEX, "b", ["rejected"], { archivedAt: T0 });
  const deps = { store, relay: {}, nowSec: () => T0 } as unknown as ChainDeps;
  const list = async (q: string) => ((await (await handleListProposals(new Request(`http://localhost/api/relay/chain/proposals?all=1${q}`), deps)).json()) as { proposals: Proposal[] }).proposals.map((p) => p.id);
  assert.deepEqual(await list(""), [kept.id]);
  assert.deepEqual((await list("&archived=1")).sort(), [kept.id, old.id].sort());

  approvals.commit((d) => {
    d.incidents.inc_new = incident("inc_new", EMMA_CODEX, "open");
    d.incidents.inc_old = { ...incident("inc_old", EMMA_CODEX, "resolved:rejected"), archivedAt: T0 };
  });
  const adeps = { store: approvals, now: () => T0 * 1000 } as unknown as ApprovalsDeps;
  const ids = async (archived: boolean) => ((await listIncidents(adeps, { archived }).json()) as { incidents: { id: string; archivedAt?: number }[] }).incidents;
  assert.deepEqual((await ids(false)).map((i) => i.id), ["inc_new"]);
  const all = await ids(true);
  assert.deepEqual(all.map((i) => i.id).sort(), ["inc_new", "inc_old"]);
  assert.equal(all.find((i) => i.id === "inc_old")!.archivedAt, T0);
});

test("reset route: chain needs the admin token (fails closed), rejects a bad body, and resets with it", async () => {
  const dir = tempDir("relay-round-route-");
  process.env.RELAY_DATA_DIR = dir;
  process.env.RELAY_ROOT_NAME = ROOT;
  delete process.env.RELAY_ADMIN_TOKEN;
  resetChainStores();
  const { POST } = await import("../../app/api/relay/admin/reset/route");
  const store = chainStore();
  const settled = proposal(store, EMMA_CODEX, "a", ["rejected"]);
  const ledger = store.ledger(TOKEN);
  assert.ok(ledger.reserve([CLOUDOPS_LEVEL], 30n * E18, `rsv_${settled.id}_1`, NOW).ok);
  assert.ok(ledger.commit(`rsv_${settled.id}_1`));

  const call = (headers: Record<string, string>, body?: unknown) =>
    POST(new Request("http://localhost:3000/api/relay/admin/reset", { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) }) as never);
  const untouched = () => {
    assert.equal(store.proposal(settled.id)!.archivedAt, undefined);
    assert.equal(store.snapshot().ledger.buckets[bucket(CLOUDOPS)].spent, (30n * E18).toString());
  };

  // Development without RELAY_ADMIN_TOKEN: the automatic meter reset is open, the chain reset is not.
  assert.equal((await call({}, { chain: true })).status, 401);
  untouched();
  process.env.RELAY_ADMIN_TOKEN = "admin-token-for-round-reset-0123456789";
  assert.equal((await call({}, { chain: true })).status, 401);
  assert.equal((await call({ authorization: "Bearer wrong" }, { chain: true })).status, 401);
  assert.equal((await call({ authorization: "Bearer admin-token-for-round-reset-0123456789" }, { chain: "yes" })).status, 400);
  assert.equal((await call({ authorization: "Bearer admin-token-for-round-reset-0123456789" }, [1])).status, 400);
  untouched();

  const ok = await call({ authorization: "Bearer admin-token-for-round-reset-0123456789" }, { chain: true });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as { cleared: string[]; chain: { archived: { proposals: number } } };
  assert.deepEqual(body.cleared, []);
  assert.equal(body.chain.archived.proposals, 1);
  assert.ok(store.proposal(settled.id)!.archivedAt);
  assert.equal(store.snapshot().ledger.buckets[bucket(CLOUDOPS)], undefined, "spent is back to 0");

  // Without chain, the chain state isn't touched.
  const next = proposal(store, EMMA_CODEX, "b", ["rejected"]);
  assert.equal((await call({ authorization: "Bearer admin-token-for-round-reset-0123456789" })).status, 200);
  assert.equal(store.proposal(next.id)!.archivedAt, undefined);
});
