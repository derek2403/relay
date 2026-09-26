// `relay pat --name <ens> [--hours H]` (scripts/relay.ts): a personal access token (PAT) for an app's
// .env. A PAT is an ordinary relay token (kr1, lib/relay/token.ts) for one ENS name, signed on this
// machine by the key in RELAY_HOME that owns the name: an agent or subagent key (agents/<name>.json),
// else the user's own key (user.json). It works with every provider the name's policy allows, through
// the OpenAI-compatible URLs <relay>/v1/<provider>/… (app/v1/[provider]/[[...path]]/route.ts).
//
//   curl -fsSL "<relay>/pat?name=derek.cloudops.dev.sodalabs.eth" | sh >> .env
//
// The relay's /pat (app/pat/route.ts) only serves a script that runs `relay pat`: the key never leaves
// this machine. Pure helpers, so tests/relay-pat.test.ts runs offline.

import { type Address, isAddressEqual } from "viem";

import { tryNormalize } from "../../lib/ens/names";
import { UserError, shortError } from "./ensv2";

/** How long a PAT lasts unless --hours says otherwise (the name's expiry and the relay's limit come first). */
export const PAT_DEFAULT_HOURS = 24;

/** Tokens end this long before the relay's longest lifetime, so a little clock skew never pushes one over it. */
export const TOKEN_TTL_MARGIN_SEC = 60;

/**
 * The normalized name, or null: an ENS name of two or more labels with nothing an agents/<name>.json
 * path or an .env line could trip on (no slashes, whitespace or control characters).
 */
export function patName(raw: string): string | null {
  const name = tryNormalize(raw);
  if (!name || !name.includes(".") || /[\s\p{Cc}/\\]/u.test(name) || name.split(".").some((label) => !label)) return null;
  return name;
}

export type PatLimit = "name" | "hours" | "relay";

/**
 * When the PAT ends: the first of the name's ENS expiry (null: unknown), now + `hours` and the relay's
 * longest token lifetime (less TOKEN_TTL_MARGIN_SEC), and which of them it was (ties go in that order).
 */
export function patExpiry(o: { now: number; ensExpiry: number | null; hours: number; maxTtlSec: number }): { exp: number; by: PatLimit } {
  const limits: [number, PatLimit][] = [
    [o.ensExpiry ?? Number.POSITIVE_INFINITY, "name"],
    [o.now + Math.round(o.hours * 3600), "hours"],
    [o.now + o.maxTtlSec - TOKEN_TTL_MARGIN_SEC, "relay"],
  ];
  const [exp, by] = limits.reduce((first, next) => (next[0] < first[0] ? next : first));
  return { exp, by };
}

/** What ENS says about the name: the highest level that isn't registered (null when all are), and the name's owner and expiry. */
export type PatChainView = { missing: string | null; owner: Address | null; expiry: number | null };

export type PatSigner = {
  /** Which local key signs: the agent key in agents/<name>.json or the user's key in user.json. */
  kind: "agent" | "user";
  /** The name's ENS expiry, null when unknown. */
  ensExpiry: number | null;
  /** Said on stderr when ENS couldn't be read and the key file or the relay was trusted instead. */
  warning?: string;
};

/**
 * Picks the local key that owns `name`. ENS decides (readChain, a walk from the .eth root, like the
 * relay's own check); when it can't be read, an agent key trusts the expiry saved with it and the
 * user's key asks the relay which names it holds (readOwned, GET /api/ens/owned). Throws a UserError
 * that says why when no local key owns the name.
 */
export async function findPatSigner(o: {
  name: string;
  /** RELAY_HOME and the command name, for messages. */
  home: string;
  cmd: string;
  agent: { address: Address; expiry: number | null } | null;
  user: { address: Address } | null;
  readChain: () => Promise<PatChainView>;
  readOwned: (address: Address) => Promise<{ name: string; expiry: number | null }[]>;
}): Promise<PatSigner> {
  const { name, home, cmd, agent, user } = o;
  if (!agent && !user) {
    throw new UserError(`No key in ${home} owns ${name}: there are no keys there. Run ${cmd} init, then ask your admin to add your address.`);
  }
  let chain: PatChainView;
  try {
    chain = await o.readChain();
  } catch (err) {
    const why = shortError(err).replace(/\.+$/, "");
    if (agent) return { kind: "agent", ensExpiry: agent.expiry, warning: `could not read ENS (${why}); using the expiry saved with ${name}'s key` };
    let owned: { name: string; expiry: number | null }[];
    try {
      owned = await o.readOwned(user!.address);
    } catch (relayErr) {
      throw new UserError(`Could not check who owns ${name}: ENS could not be read (${why}), nor could the relay (${shortError(relayErr).replace(/\.+$/, "")}).`);
    }
    const hit = owned.find((n) => n.name === name);
    if (hit) return { kind: "user", ensExpiry: hit.expiry, warning: `could not read ENS (${why}); the relay says your key owns ${name}` };
    throw new UserError(
      `No key in ${home} owns ${name}: the relay lists ${owned.length ? owned.map((n) => n.name).join(", ") : "no names"} for your key ${user!.address} (ENS could not be read: ${why}).`,
    );
  }
  if (chain.missing === name) {
    throw new UserError(`${name} is not registered on ENS (or it has expired).${agent ? ` Its key is still in ${home}; ${cmd} login creates your agent again.` : ""}`);
  }
  if (chain.missing) throw new UserError(`${name} can't be reached: ${chain.missing} is not registered (it was removed or has expired).`);
  const owner = chain.owner;
  if (owner && agent && isAddressEqual(owner, agent.address)) return { kind: "agent", ensExpiry: chain.expiry };
  if (owner && user && isAddressEqual(owner, user.address)) return { kind: "user", ensExpiry: chain.expiry };
  const yours = user ? ` (your key is ${user.address})` : "";
  throw new UserError(`No key in ${home} owns ${name}: it belongs to ${owner ?? "nobody"}${yours}. A PAT is signed by the key that owns the name.`);
}

/** A relay origin (and optional path) that is safe unquoted in .env files and shells. */
const SAFE_BASE = /^https?:\/\/[A-Za-z0-9._:[\]-]+(?:\/[A-Za-z0-9._~%/-]*)?$/;
/** kr1.<base64url payload>.<signature hex> (lib/relay/token.ts): nothing to quote. */
const TOKEN_SHAPE = /^kr1\.[A-Za-z0-9_-]+\.0x[0-9a-fA-F]+$/;

/** "2026-09-28T09:30:00Z" */
export const isoTime = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.000Z$/, "Z");

/**
 * The only lines `relay pat` prints on stdout, ready to append to an .env file: a comment naming the
 * relay, then the PAT as RELAY_PAT. The app keeps the relay's URL (<relay>/v1/<provider>/…) itself.
 */
export function patEnvLines(o: { name: string; base: string; token: string; exp: number }): string[] {
  const base = o.base.replace(/\/+$/, "");
  if (!SAFE_BASE.test(base)) throw new UserError(`The relay URL ${o.base} has characters that don't belong in an .env file.`);
  if (!TOKEN_SHAPE.test(o.token)) throw new Error("the signed token has an unexpected shape");
  return [
    `# Keyless Relay PAT for ${o.name} · expires ${isoTime(o.exp)} · ${base}`,
    `RELAY_PAT=${o.token}`,
  ];
}
