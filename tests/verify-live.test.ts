// npm run verify:live, offline: the links it prints, how limits, expiry, checks and reverts are
// described, the tree layout, which member it tests, and the small helpers under them.

import assert from "node:assert/strict";
import test from "node:test";

import { keccak256, stringToBytes } from "viem";

import { textKeyResource } from "../lib/ens/access";
import { dnsEncode } from "../lib/ens/names";
import { ALL_ROLES, REGISTRY_ROLE_TABLE, RESOLVER_ROLE_TABLE, RegistryRoles, ResolverRoles } from "../lib/ens/roles";
import { type Bundle, RECORD_KEYS } from "../lib/relay/bundle";
import {
  type LevelFacts,
  addressUrl,
  bitmapHex,
  describeBitmap,
  describeRevert,
  dnsDecode,
  formatChecks,
  formatElapsed,
  formatExpiry,
  formatLimits,
  formatRecords,
  isAccessDenied,
  kindByDepth,
  layoutTree,
  levelPasses,
  makeStyle,
  mapPool,
  pickMember,
  short,
  shortHex,
  tokenUrl,
  wantsColor,
  wrapParts,
} from "../scripts/lib/verify-live";

const REGISTRY = "0xb89BEd285Cbb184fB31d8b95e078D50D454aD853";
const RESOLVER = "0xe487428286A19151eEC4755CcAe32910dCE30154";
const EMMA = "0xab00130f314D511AB59E4AdfFCd59A8d229750D0";
const plain = makeStyle(false);

// --- Links --------------------------------------------------------------------------------------------

test("Etherscan links: an address page, and a name's ERC-1155 token as the registry's token page filtered by token ID", () => {
  assert.equal(addressUrl(EMMA), `https://sepolia.etherscan.io/address/${EMMA}`);
  const tokenId = 3531089572230997759736648910078935077997651910238765641779090874575488024576n;
  assert.equal(tokenUrl(REGISTRY, tokenId), `https://sepolia.etherscan.io/token/${REGISTRY}?a=3531089572230997759736648910078935077997651910238765641779090874575488024576`);
  // Decimal, never hex or exponent notation.
  assert.ok(!/e\+|0x/.test(tokenUrl(REGISTRY, 2n ** 255n).split("?a=")[1]));
});

test("short forms keep the ends of addresses and big numbers", () => {
  assert.equal(short(EMMA), "0xab00…50D0");
  assert.equal(short("0x1234"), "0x1234");
  assert.equal(shortHex(0n), "0x0");
  assert.equal(shortHex(0x10n), "0x10");
  // A resource reads like the keccak256 it is (32 bytes, leading zeros kept).
  const hash = keccak256(stringToBytes("relay.cap.codex"));
  assert.ok(hash.startsWith("0x0"), "this key's hash starts with a zero nybble");
  assert.equal(shortHex(textKeyResource("relay.cap.codex")), `${hash.slice(0, 8)}…${hash.slice(-4)}`);
  assert.equal(shortHex(2n ** 64n), "0x000000…0000");
  assert.equal(bitmapHex(0n), "0x0");
  assert.equal(bitmapHex(ALL_ROLES), `0x${"1".repeat(64)}`);
  assert.equal(formatElapsed(12_345), "12.3 s");
});

test("role bitmaps are shown raw with the roles they hold", () => {
  assert.equal(describeBitmap(0n, RESOLVER_ROLE_TABLE), "0x0 (no roles)");
  assert.equal(describeBitmap(RegistryRoles.ROLE_SET_SUBREGISTRY, REGISTRY_ROLE_TABLE), "0x100000 (ROLE_SET_SUBREGISTRY)");
  assert.equal(describeBitmap(ResolverRoles.ROLE_SET_TEXT | ResolverRoles.ROLE_SET_ADDRESS, RESOLVER_ROLE_TABLE), "0x11 (ROLE_SET_ADDRESS, ROLE_SET_TEXT)");
  assert.match(describeBitmap(ALL_ROLES, RESOLVER_ROLE_TABLE), /^0x1{64} \(20 roles: ROLE_SET_ADDRESS, ROLE_SET_ADDRESS_ADMIN, ROLE_SET_TEXT, …\)$/);
});

// --- Names --------------------------------------------------------------------------------------------------

test("a name found on chain gets its kind from its depth below the root", () => {
  const root = "sodalabs.eth";
  assert.equal(kindByDepth(root, root), "company");
  assert.equal(kindByDepth("dev.sodalabs.eth", root), "department");
  assert.equal(kindByDepth("cloudops.dev.sodalabs.eth", root), "team");
  assert.equal(kindByDepth("derek.cloudops.dev.sodalabs.eth", root), "employee");
  assert.equal(kindByDepth("codex.derek.cloudops.dev.sodalabs.eth", root), "agent");
  assert.equal(kindByDepth("tests.codex.derek.cloudops.dev.sodalabs.eth", root), "subagent");
  assert.equal(kindByDepth("x.tests.codex.derek.cloudops.dev.sodalabs.eth", root), "subagent");
});

test("dnsDecode reverses dnsEncode (findCanonicalName returns DNS wire format)", () => {
  for (const name of ["cloudops.dev.sodalabs.eth", "sodalabs.eth", "eth", "a.b"]) assert.equal(dnsDecode(dnsEncode(name)), name);
  assert.equal(dnsDecode("0x"), "");
  assert.equal(dnsDecode("0x00"), "");
});

test("the member to test: --member, else a live derek.* under a team, else emma of cloudops, else the first employee", () => {
  const root = "sodalabs.eth";
  const emma = { name: "emma.cloudops.dev.sodalabs.eth", kind: "employee" as const, registered: true };
  const nina = { name: "nina.mobile.dev.sodalabs.eth", kind: "employee" as const, registered: true };
  const derek = { name: "derek.cloudops.dev.sodalabs.eth", kind: "employee" as const, registered: true };
  assert.deepEqual(pickMember([emma, derek], root, "nina.mobile.dev.sodalabs.eth"), { name: "nina.mobile.dev.sodalabs.eth", why: "chosen with --member" });
  assert.equal(pickMember([emma, nina, derek], root)!.name, derek.name);
  assert.match(pickMember([emma, nina, derek], root)!.why, /added live/);
  // Two live dereks: the first by name, so every run picks the same one.
  assert.equal(pickMember([emma, { ...derek, name: "derek.web.dev.sodalabs.eth" }, derek], root)!.name, derek.name);
  // A removed derek, or one that isn't directly under a team (an agent called derek), doesn't count.
  assert.equal(pickMember([emma, { ...derek, registered: false }], root)!.name, emma.name);
  assert.equal(pickMember([emma, { name: "derek.orbit.emma.cloudops.dev.sodalabs.eth", kind: "agent", registered: true }], root)!.name, emma.name);
  assert.match(pickMember([emma, nina], root)!.why, /no derek\.\* member/);
  assert.equal(pickMember([nina, { ...emma, registered: false }], root)!.name, nina.name);
  assert.equal(pickMember([{ name: root, kind: "company", registered: true }], root), null);
});

// --- Limits, expiry, checks ------------------------------------------------------------------------------------

const bundle = (b: Partial<Bundle>): Bundle => ({ keys: [], caps: {}, maxes: {}, period: "month", ...b });

test("limits read like the relay parsed them: each key with its dollar and count caps, then the period", () => {
  assert.equal(
    formatLimits(bundle({ keys: ["codex", "claude", "github", "vercel"], caps: { codex: 100, claude: 50 } })),
    "codex $100 · claude $50 · github · vercel · per month",
  );
  assert.equal(
    formatLimits(bundle({ keys: ["openai-images", "codex", "weather"], caps: { codex: 4 }, maxes: { "openai-images": 10, weather: 1 }, period: "total" })),
    "openai-images 10 images · codex $4 · weather 1 request · in total",
  );
  assert.equal(formatLimits(bundle({ keys: ["codex"], caps: { codex: 2 }, maxes: { codex: 5 }, period: "day" })), "codex $2 + 5 requests · per day (UTC)");
  assert.equal(formatLimits(bundle({ keys: [] })), "no keys · per month");
  assert.match(formatLimits(null), /^no bundle/);
});

test("raw records: only the set ones, quoted", () => {
  assert.deepEqual(formatRecords({ [RECORD_KEYS.keys]: "codex,claude", [RECORD_KEYS.cap("codex")]: "100", [RECORD_KEYS.cap("claude")]: "", [RECORD_KEYS.period]: "month" }), [
    'relay.keys="codex,claude"',
    'relay.cap.codex="100"',
    'relay.period="month"',
  ]);
});

test("expiry: date and days left, or when it expired", () => {
  const now = Date.UTC(2026, 8, 27) / 1000;
  assert.equal(formatExpiry(now + 364 * 86_400 + 60, now), "expires 2027-09-26 (364 d)");
  assert.equal(formatExpiry(now - 86_400, now), "expired 2026-09-26");
  assert.equal(formatExpiry(null, now), "no expiry");
});

const level = (over: Partial<LevelFacts> = {}): LevelFacts => ({
  status: "registered",
  registry: REGISTRY,
  resolver: RESOLVER,
  checks: { registryVerified: true, resolverVerified: true, canonical: true },
  ...over,
});

test("a level passes only when registered, genuine and canonical (n/a counts as fine, as in the relay)", () => {
  assert.equal(levelPasses(level()), true);
  assert.equal(levelPasses(level({ checks: { registryVerified: null, resolverVerified: true, canonical: null } })), true, "the root in ETHRegistry");
  assert.equal(levelPasses(level({ status: "available" })), false);
  assert.equal(levelPasses(level({ checks: { registryVerified: false, resolverVerified: true, canonical: true } })), false);
  assert.equal(levelPasses(level({ checks: { registryVerified: true, resolverVerified: null, canonical: true } })), false, "no resolver, no bundle");
  assert.equal(levelPasses(level({ checks: { registryVerified: true, resolverVerified: true, canonical: false } })), false, "an alias path");
});

test("the checks line names each check with the address it was made on", () => {
  assert.equal(
    formatChecks(level(), plain),
    "✓ registered  ✓ UserRegistry proxy 0xb89B…D853  ✓ PermissionedResolver proxy 0xe487…0154  ✓ canonical parent pointer",
  );
  const root = formatChecks(level({ registry: "0x0000000000000000000000000000000000000E7E", checks: { registryVerified: null, resolverVerified: true, canonical: null } }), plain, () => "ETHRegistry");
  assert.equal(root, "✓ registered  – in ETHRegistry (core registry)  ✓ PermissionedResolver proxy 0xe487…0154  – canonical n/a");
  const bad = formatChecks(level({ status: "missing", checks: { registryVerified: false, resolverVerified: false, canonical: false } }), plain);
  assert.match(bad, /^✗ not reachable from the root  ✗ registry 0xb89B…D853 is not a UserRegistry proxy  ✗ resolver 0xe487…0154 is not a PermissionedResolver proxy  ✗ registry doesn't point back/);
  assert.match(formatChecks(level({ resolver: null, checks: { registryVerified: true, resolverVerified: null, canonical: true } }), plain), /✗ no resolver/);
});

test("colors only on a terminal; NO_COLOR and TERM=dumb turn them off, FORCE_COLOR on", () => {
  assert.equal(wantsColor({ isTTY: true }, {}), true);
  assert.equal(wantsColor({ isTTY: false }, {}), false);
  assert.equal(wantsColor({}, {}), false);
  assert.equal(wantsColor({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(wantsColor({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(wantsColor({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(wantsColor({ isTTY: false }, { FORCE_COLOR: "0" }), false);
  assert.equal(makeStyle(false).dim("x"), "x");
  assert.equal(makeStyle(true).dim("x"), "\x1b[2mx\x1b[22m");
  assert.equal(makeStyle(true).ok, "\x1b[32m✓\x1b[39m");
});

// --- Layout -----------------------------------------------------------------------------------------------------

test("wrapParts fills lines up to the width, one part at least per line", () => {
  assert.deepEqual(wrapParts(["aaa", "bbb", "ccc"], 9), ["aaa · bbb", "ccc"]);
  assert.deepEqual(wrapParts(["aaa", "bbb", "ccc"], 100), ["aaa · bbb · ccc"]);
  assert.deepEqual(wrapParts(["a-very-long-part", "b"], 5), ["a-very-long-part", "b"]);
  assert.deepEqual(wrapParts([], 10), []);
  assert.deepEqual(wrapParts(["x", "y"], 4, "  "), ["x  y"]);
  assert.deepEqual(wrapParts(["x", "y"], 3, "  "), ["x", "y"]);
});

test("layoutTree draws ├─ └─ │ prefixes for names and their detail lines", () => {
  const kids: Record<string, string[]> = { root: ["a", "b"], a: ["a1"], a1: [], b: [] };
  const rows = layoutTree("root", (n) => kids[n] ?? []);
  assert.deepEqual(
    rows.map((r) => [r.name, r.depth, r.head, r.body]),
    [
      ["root", 0, "", "│  "],
      ["a", 1, "├─ ", "│  │  "],
      ["a1", 2, "│  └─ ", "│        "],
      ["b", 1, "└─ ", "      "],
    ],
  );
});

// --- Reverts ------------------------------------------------------------------------------------------------------

test("an access-control revert is explained: which resource, which role, whose account", () => {
  const capKey = RECORD_KEYS.cap("codex");
  const resource = textKeyResource(capKey);
  const text = describeRevert(
    { name: "EACUnauthorizedAccountRoles", args: [resource, ResolverRoles.ROLE_SET_TEXT, EMMA] },
    { table: RESOLVER_ROLE_TABLE, resources: new Map([[resource, `resource("${capKey}")`]]), accounts: new Map([[EMMA.toLowerCase(), "emma"]]) },
  );
  assert.equal(text, `EACUnauthorizedAccountRoles(resource ${shortHex(resource)} = resource("relay.cap.codex"), roleBitmap 0x10 (ROLE_SET_TEXT), account 0xab00…50D0 = emma)`);
  assert.equal(
    describeRevert({ name: "EACCannotGrantRoles", args: [0n, ResolverRoles.ROLE_SET_TEXT, EMMA] }, { table: RESOLVER_ROLE_TABLE }),
    "EACCannotGrantRoles(resource 0 = ROOT_RESOURCE, roleBitmap 0x10 (ROLE_SET_TEXT), account 0xab00…50D0)",
  );
  assert.equal(describeRevert({ name: "LabelExpired", args: [5n] }), "LabelExpired(5)");
  assert.equal(isAccessDenied("EACUnauthorizedAccountRoles"), true);
  assert.equal(isAccessDenied("EACCannotGrantRoles"), true);
  assert.equal(isAccessDenied("LabelExpired"), false);
  assert.equal(isAccessDenied(null), false);
});

// --- Concurrency ------------------------------------------------------------------------------------------------

test("mapPool keeps the order and never runs more than `size` at once", async () => {
  let running = 0;
  let most = 0;
  const out = await mapPool([30, 10, 20, 5, 1], 2, async (ms, i) => {
    running++;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return i * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
  assert.equal(most, 2);
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
});
