// Pure helpers for npm run verify:live (scripts/verify-live.ts): Etherscan links, how a name's
// limits, checks and expiry are printed, the tree layout, which member to test, and how a revert
// is described. No I/O, so tests/verify-live.test.ts runs offline.
//
// Relative imports only (like ensv2.ts).

import { type Hex, hexToBytes } from "viem";

import { type RoleInfo, decodeRoles } from "../../lib/ens/roles";
import type { Bundle, Period } from "../../lib/relay/bundle";
import { countText } from "../../lib/relay/catalog";
import type { ChainLevel } from "../../lib/relay/ens";

// --- Links -------------------------------------------------------------------------------------------

export const ETHERSCAN = "https://sepolia.etherscan.io";

export const addressUrl = (address: string) => `${ETHERSCAN}/address/${address}`;

/**
 * A name's ERC-1155 token: the registry's token page filtered to one token ID (Etherscan's `?a=`
 * takes a holder address or, for ERC-721/1155 contracts, a token ID; checked on Sepolia).
 */
export const tokenUrl = (registry: string, tokenId: bigint) => `${ETHERSCAN}/token/${registry}?a=${tokenId.toString()}`;

// --- Short forms -----------------------------------------------------------------------------------------

/** 0x3177…BE7B */
export const short = (hex: string) => (hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex);

/** A uint256 as hex; a big one (a hash, a resource) as its 32 bytes, shortened: 0x0ce7ae…987b */
export const shortHex = (v: bigint) => {
  const digits = v.toString(16);
  if (digits.length <= 16) return `0x${digits}`;
  const hex = `0x${digits.padStart(64, "0")}`;
  return `${hex.slice(0, 8)}…${hex.slice(-4)}`;
};

/** A role bitmap exactly as stored (0x0, 0x10, 0x1111…1111). */
export const bitmapHex = (v: bigint) => `0x${v.toString(16)}`;

/** A bitmap with the roles it holds: "0x100000 (ROLE_SET_SUBREGISTRY)", "0x0 (no roles)". */
export const describeBitmap = (v: bigint, table: RoleInfo[]) => {
  const names = decodeRoles(v, table);
  if (!names.length) return `${bitmapHex(v)} (no roles)`;
  return `${bitmapHex(v)} (${names.length > 4 ? `${names.length} roles: ${names.slice(0, 3).join(", ")}, …` : names.join(", ")})`;
};

export const formatElapsed = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// --- Names ---------------------------------------------------------------------------------------------------

export type NameKind = "company" | "department" | "team" | "employee" | "agent" | "subagent" | "alias";

const DEPTH_KINDS: NameKind[] = ["company", "department", "team", "employee", "agent", "subagent"];

const depthOf = (name: string, root: string) => (name === root ? 0 : name.slice(0, -root.length - 1).split(".").length);

/** The kind of a name found on chain, from how far below the root it sits (the seeded shape). */
export const kindByDepth = (name: string, root: string): NameKind => DEPTH_KINDS[Math.min(depthOf(name, root), DEPTH_KINDS.length - 1)];

/** Decodes a DNS wire-format name (UniversalHelper.findCanonicalName); "" for the root or empty bytes. */
export function dnsDecode(hex: Hex): string {
  const bytes = hexToBytes(hex);
  const labels: string[] = [];
  for (let i = 0; i < bytes.length && bytes[i] !== 0; i += bytes[i] + 1) {
    labels.push(new TextDecoder().decode(bytes.slice(i + 1, i + 1 + bytes[i])));
  }
  return labels.join(".");
}

export type MemberCandidate = { name: string; kind: NameKind; registered: boolean };

/**
 * Whose limits section 2 tries to raise: --member, else a member added live whose name starts
 * with "derek." directly under a team, else emma.cloudops.dev.<root>, else the first registered
 * employee. Null when there is nobody to test.
 */
export function pickMember(candidates: MemberCandidate[], root: string, explicit?: string | null): { name: string; why: string } | null {
  if (explicit) return { name: explicit, why: "chosen with --member" };
  const live = candidates
    .filter((c) => c.registered && c.kind === "employee" && c.name.startsWith("derek."))
    .map((c) => c.name)
    .sort();
  if (live.length) return { name: live[0], why: "a member added live (derek.*)" };
  const emma = `emma.cloudops.dev.${root}`;
  const nobodyLive = "no derek.* member is registered under a team right now, so a seeded employee";
  if (candidates.some((c) => c.name === emma && c.registered)) return { name: emma, why: nobodyLive };
  const first = candidates.find((c) => c.registered && c.kind === "employee");
  return first ? { name: first.name, why: nobodyLive } : null;
}

// --- Limits, expiry, checks --------------------------------------------------------------------------------

const PERIOD_TEXT: Record<Period, string> = { month: "per month", day: "per day (UTC)", total: "in total" };

/**
 * A bundle as the relay parsed it (parseBundle): each allowed key with its dollar cap and count
 * cap at this level (none: only the levels above limit it), then the period.
 */
export function formatLimits(bundle: Bundle | null): string {
  if (!bundle) return "no bundle (relay.keys is empty: this name gets nothing)";
  if (!bundle.keys.length) return `no keys · ${PERIOD_TEXT[bundle.period]}`;
  const parts = bundle.keys.map((k) => {
    const cap = bundle.caps[k];
    const max = bundle.maxes?.[k];
    const limits = [cap !== undefined ? `$${cap}` : null, max !== undefined ? countText(k, max) : null].filter(Boolean);
    return limits.length ? `${k} ${limits.join(" + ")}` : k;
  });
  return `${parts.join(" · ")} · ${PERIOD_TEXT[bundle.period]}`;
}

/** Text records that are set, as key="value" (the raw values a bundle is parsed from). */
export const formatRecords = (texts: Record<string, string>) =>
  Object.entries(texts)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`);

export function formatExpiry(expiry: number | null, now: number): string {
  if (!expiry) return "no expiry";
  const date = new Date(expiry * 1000).toISOString().slice(0, 10);
  const days = Math.floor((expiry - now) / 86_400);
  return expiry > now ? `expires ${date} (${days} d)` : `expired ${date}`;
}

export type Style = {
  dim: (s: string) => string;
  bold: (s: string) => string;
  green: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  ok: string;
  bad: string;
  na: string;
};

/** Colors only for a terminal (NO_COLOR and TERM=dumb turn them off, FORCE_COLOR on). */
export function wantsColor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY && !env.NO_COLOR && env.TERM !== "dumb";
}

export function makeStyle(color: boolean): Style {
  const sgr = (open: number, close: number) => (s: string) => (color ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  const green = sgr(32, 39);
  const red = sgr(31, 39);
  return { dim: sgr(2, 22), bold: sgr(1, 22), green, red, yellow: sgr(33, 39), ok: green("✓"), bad: red("✗"), na: "–" };
}

export type LevelFacts = Pick<ChainLevel, "status" | "registry" | "resolver" | "checks">;

/** Every check the relay makes on a level passed (null: not applicable, e.g. the root in ETHRegistry). */
export const levelPasses = (l: LevelFacts) =>
  l.status === "registered" && l.checks.registryVerified !== false && l.checks.resolverVerified === true && l.checks.canonical !== false;

/** The relay's per-level checks on one line, each with the address it was made on. */
export function formatChecks(l: LevelFacts, s: Style, coreRegistry: (a: string) => string | null = () => null): string {
  const parts: string[] = [];
  parts.push(l.status === "registered" ? `${s.ok} registered` : `${s.bad} ${l.status === "missing" ? "not reachable from the root" : l.status}`);
  const core = l.registry ? coreRegistry(l.registry) : null;
  if (l.checks.registryVerified === true) parts.push(`${s.ok} UserRegistry proxy ${short(l.registry!)}`);
  else if (l.checks.registryVerified === false) parts.push(`${s.bad} registry ${short(l.registry!)} is not a UserRegistry proxy`);
  else if (l.registry) parts.push(`${s.na} in ${core ?? short(l.registry)} (core registry)`);
  if (l.checks.resolverVerified === true) parts.push(`${s.ok} PermissionedResolver proxy ${short(l.resolver!)}`);
  else if (l.checks.resolverVerified === false) parts.push(`${s.bad} resolver ${short(l.resolver!)} is not a PermissionedResolver proxy`);
  else parts.push(`${s.bad} no resolver`);
  if (l.checks.canonical === true) parts.push(`${s.ok} canonical parent pointer`);
  else if (l.checks.canonical === false) parts.push(`${s.bad} registry doesn't point back at the parent (not canonical)`);
  else if (l.registry) parts.push(`${s.na} canonical n/a`);
  return parts.join("  ");
}

// --- Layout --------------------------------------------------------------------------------------------

/** Joins parts with " · " into lines of at most `width` characters (a part longer than that gets its own line). */
export function wrapParts(parts: string[], width: number, sep = " · "): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    if (line && line.length + sep.length + part.length > width) {
      lines.push(line);
      line = part;
    } else line = line ? `${line}${sep}${part}` : part;
  }
  if (line) lines.push(line);
  return lines;
}

export type TreeRow = { name: string; depth: number; head: string; body: string };

/** Rows of a tree drawn with ├─ └─ │: `head` prefixes the name's line, `body` its detail lines. */
export function layoutTree(root: string, childrenOf: (name: string) => string[]): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (name: string, prefix: string, last: boolean, depth: number) => {
    const top = depth === 0;
    const kids = childrenOf(name);
    const below = top ? "" : `${prefix}${last ? "   " : "│  "}`;
    rows.push({ name, depth, head: top ? "" : `${prefix}${last ? "└─ " : "├─ "}`, body: `${below}${kids.length ? "│  " : "   "}` });
    kids.forEach((c, i) => walk(c, below, i === kids.length - 1, depth + 1));
  };
  walk(root, "", true, 0);
  return rows;
}

// --- Reverts ---------------------------------------------------------------------------------------------

const EAC_ERRORS = new Set(["EACUnauthorizedAccountRoles", "EACCannotGrantRoles", "EACCannotRevokeRoles"]);

/** An access-control refusal (the only kind of revert that proves "not allowed"). */
export const isAccessDenied = (name: string | null | undefined) => !!name && EAC_ERRORS.has(name);

/**
 * A decoded ENSv2 custom error with its arguments explained, e.g.
 * EACUnauthorizedAccountRoles(resource 0x9f3c…77a2 = resource("relay.cap.codex"), roleBitmap 0x10 (ROLE_SET_TEXT), account 0xab00…50D0 = emma…).
 */
export function describeRevert(
  err: { name: string; args?: readonly unknown[] },
  ctx: { table?: RoleInfo[]; resources?: Map<bigint, string>; accounts?: Map<string, string> } = {},
): string {
  const args = err.args ?? [];
  if (!EAC_ERRORS.has(err.name) || args.length !== 3) return `${err.name}(${args.map((a) => String(a)).join(", ")})`;
  const [resource, roleBitmap, account] = args as [bigint, bigint, string];
  const known = ctx.resources?.get(resource);
  const res = resource === 0n ? "0 = ROOT_RESOURCE" : `${shortHex(resource)}${known ? ` = ${known}` : ""}`;
  const roles = ctx.table ? decodeRoles(roleBitmap, ctx.table) : [];
  const who = ctx.accounts?.get(account.toLowerCase());
  return `${err.name}(resource ${res}, roleBitmap ${bitmapHex(roleBitmap)}${roles.length ? ` (${roles.join(", ")})` : ""}, account ${short(account)}${who ? ` = ${who}` : ""})`;
}

// --- Concurrency -------------------------------------------------------------------------------------------

/** Maps `items` through `fn` with at most `size` running at once, keeping the order. */
export async function mapPool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, worker));
  return out;
}
