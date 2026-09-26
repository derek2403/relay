import assert from "node:assert/strict";
import test from "node:test";

import { TX_VARIANT_CLASS, currentStep, shortHash, txBlockReason, txBusyLabel, txStatusView } from "../components/live/tx/txView";
import type { TxState } from "../lib/hooks/useTx";
import {
  bundleEditorModel,
  catalogIcon,
  levelsAbove,
  listOf,
  parseLimit,
  rowNotes,
  setCap,
  setMax,
  setPeriod,
  toggleKey,
  validateDraft,
} from "../lib/live-bundle-editor";
import type { BundleDraft } from "../lib/relay/browser";
import type { Bundle } from "../lib/relay/bundle";
import { CATALOG } from "../lib/relay/catalog";

const draft = (over: Partial<BundleDraft> = {}): BundleDraft => ({ keys: [], caps: {}, maxes: {}, period: "month", ...over });
const rows = (m: ReturnType<typeof bundleEditorModel>) => m.groups.flatMap((g) => g.rows);
const row = (m: ReturnType<typeof bundleEditorModel>, id: string) => rows(m).find((r) => r.id === id);

// --- Tx ---------------------------------------------------------------------------------

test("tx button: wallet, chain and busy reasons in that order", () => {
  assert.equal(txBlockReason({ isConnected: false, chainId: undefined, targetChainId: 11155111, busy: true }), "Connect a wallet first.");
  assert.equal(txBlockReason({ isConnected: true, chainId: 1, targetChainId: 11155111, busy: false }), "Switch to Sepolia.");
  assert.equal(txBlockReason({ isConnected: true, chainId: 11155111, targetChainId: 11155111, busy: true }), "Another transaction is in progress.");
  assert.equal(txBlockReason({ isConnected: true, chainId: 11155111, targetChainId: 11155111, busy: false }), null);
});

test("tx button: busy labels and variant classes", () => {
  assert.equal(txBusyLabel("signing"), "Confirm in wallet…");
  assert.equal(txBusyLabel("pending"), "Waiting…");
  for (const s of ["idle", "success", "reverted", "error"] as const) assert.equal(txBusyLabel(s), null);
  assert.equal(TX_VARIANT_CLASS.detail, "detail-button");
  assert.equal(TX_VARIANT_CLASS.danger, "revoke-button");
  assert.equal(TX_VARIANT_CLASS["danger-solid"], "danger");
});

test("tx status: badges, hash, receipt line and error", () => {
  const hash = `0x${"ab".repeat(32)}` as const;
  assert.equal(txStatusView({ status: "idle" }), null);
  assert.deepEqual(txStatusView({ status: "signing" }), { badge: "Awaiting signature", tone: "info", hash: null, receipt: null, error: null });
  assert.equal(txStatusView({ status: "pending", hash })?.hash, hash);
  const receipt = { blockNumber: 123n, gasUsed: 45678n } as unknown as Extract<TxState, { status: "success" }>["receipt"];
  const ok = txStatusView({ status: "success", hash, receipt, events: [] });
  assert.equal(ok?.badge, "Confirmed");
  assert.equal(ok?.receipt, "block 123 · gas 45678");
  assert.equal(txStatusView({ status: "reverted", hash, receipt, events: [] })?.badge, "Reverted");
  const failed = txStatusView({ status: "error", error: "User rejected the request." });
  assert.equal(failed?.badge, "Failed");
  assert.equal(failed?.tone, "bad");
  assert.equal(failed?.error, "User rejected the request.");
  assert.equal(shortHash(hash), `0xabababab…abababab`);
});

// --- Steps ------------------------------------------------------------------------------

test("steps: the current step is the first open one that isn't blocked", () => {
  assert.equal(currentStep([{ done: true }, { done: false }, { done: false }]), 1);
  assert.equal(currentStep([{ done: true }, { done: false, active: false }, { done: false, active: true }]), 2);
  assert.equal(currentStep([{ done: true }, { done: true }]), -1);
});

// --- BundleEditor -----------------------------------------------------------------------

test("icons: claude, openai-images and mock map to their marks", () => {
  assert.equal(catalogIcon("claude"), "anthropic");
  assert.equal(catalogIcon("openai-images"), "openai");
  assert.equal(catalogIcon("codex"), "codex");
  assert.equal(catalogIcon("mock"), "relay");
});

test("inputs: $ caps only for dollarCaps APIs, count limits for all", () => {
  const m = bundleEditorModel(draft(), undefined);
  assert.equal(rows(m).length, CATALOG.length);
  for (const entry of CATALOG) {
    const r = row(m, entry.id)!;
    assert.equal(r.showCap, entry.dollarCaps, entry.id);
    assert.equal(r.showMax, true);
  }
  assert.equal(row(m, "openai-images")!.unit, "images");
  assert.equal(row(m, "github")!.unit, "requests");
  assert.equal(row(m, "codex")!.capPlaceholder, "no cap");
  assert.equal(row(m, "codex")!.maxPlaceholder, "no limit");
  assert.equal(m.loading, false);
  assert.equal(bundleEditorModel(draft(), null).loading, true);
});

test("parent: blocked APIs are hidden unless ticked, with a note per level", () => {
  const parent: Bundle = { keys: ["codex", "github"], caps: { codex: 5 }, maxes: { github: 100 }, period: "month" };
  const above = levelsAbove({ parent, parentName: "eng.acme.eth" });
  const m = bundleEditorModel(draft({ keys: ["codex", "stripe"] }), above);
  const ids = rows(m).map((r) => r.id);
  assert.ok(ids.includes("codex") && ids.includes("github") && ids.includes("stripe"));
  assert.ok(!ids.includes("slack"));
  assert.deepEqual(row(m, "stripe")!.notes, ["Blocked above: eng.acme.eth doesn't allow it."]);
  assert.equal(row(m, "codex")!.capPlaceholder, "≤ 5");
  assert.equal(row(m, "github")!.maxPlaceholder, "≤ 100");
  assert.equal(m.unavailable.length, 1);
  assert.match(m.unavailable[0], /aren't available: eng\.acme\.eth doesn't allow them\.$/);
});

test("parent: caps above the parent are flagged, $ and counts", () => {
  const limits = { blockedBy: null, cap: { value: 5, by: "eng.acme.eth" }, max: { value: 100, by: "acme.eth" } };
  assert.deepEqual(rowNotes("codex", { on: true, cap: "$7", max: "150" }, limits), ["Capped by eng.acme.eth at $5.", "Capped by acme.eth at 100 requests."]);
  assert.deepEqual(rowNotes("codex", { on: true, cap: "5", max: "" }, limits), []);
  assert.deepEqual(rowNotes("codex", { on: false, cap: "9", max: "900" }, limits), []);
  // github has no dollar caps: a stray cap value never warns.
  assert.deepEqual(rowNotes("github", { on: true, cap: "9", max: "" }, limits), []);
  assert.deepEqual(rowNotes("openai-images", { on: true, cap: "", max: "101" }, limits), ["Capped by acme.eth at 100 images."]);
});

test("levels: `above` wins, a null parent flags nothing", () => {
  assert.equal(levelsAbove({}), undefined);
  assert.equal(levelsAbove({ parent: null, parentName: "x.eth" }), undefined);
  assert.equal(levelsAbove({ above: null, parent: { keys: [], caps: {}, period: "month" } }), null);
  const denyAll = bundleEditorModel(draft(), [{ name: "acme.eth", bundle: null }]);
  assert.equal(rows(denyAll).length, 0);
  assert.equal(levelsAbove({ parent: { keys: ["mock"], caps: {}, period: "day" } })![0].name, "the parent");
});

test("draft edits are immutable and validation passes through bundleFromDraft", () => {
  const d0 = draft();
  const d1 = toggleKey(d0, "codex", true);
  assert.deepEqual(d0.keys, []);
  assert.deepEqual(toggleKey(d1, "codex", true).keys, ["codex"]);
  const d2 = setMax(setCap(toggleKey(d1, "mock", true), "codex", "2.5"), "mock", "10");
  assert.deepEqual(validateDraft(d2), { bundle: { keys: ["codex", "mock"], caps: { codex: 2.5 }, maxes: { mock: 10 }, period: "month" }, error: null });
  assert.equal(setPeriod(d2, "total").period, "total");
  assert.deepEqual(toggleKey(d2, "codex", false).keys, ["mock"]);
  assert.equal(validateDraft(d0).error, "Pick at least one API.");
  assert.match(validateDraft(setCap(d1, "codex", "abc")).error ?? "", /cap must be a dollar amount/);
  assert.match(validateDraft(setMax(d1, "codex", "1.5")).error ?? "", /whole number of requests/);
  // Empty = no cap.
  assert.deepEqual(validateDraft(setCap(d1, "codex", ""))?.bundle?.caps, {});
});

test("small helpers", () => {
  assert.equal(listOf(["A"]), "A");
  assert.equal(listOf(["A", "B", "C"]), "A, B and C");
  assert.equal(parseLimit(" $3 "), 3);
  assert.equal(parseLimit(""), null);
  assert.equal(parseLimit("x"), null);
});
