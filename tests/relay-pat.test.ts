// `relay pat` (scripts/lib/pat.ts): which local key signs a PAT, when it ends, and the exact .env
// lines it prints. Offline: ENS and the relay are fakes.

import assert from "node:assert/strict";
import test from "node:test";

import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { UserError } from "../scripts/lib/ensv2";
import { PAT_DEFAULT_HOURS, TOKEN_TTL_MARGIN_SEC, findPatSigner, isoTime, patEnvLines, patExpiry, patName } from "../scripts/lib/pat";
import { DEFAULT_MAX_TOKEN_TTL_SEC, createToken, parseToken, verifyToken } from "../lib/relay/token";

const AGENT = "0x1111111111111111111111111111111111111111" as Address;
const USER = "0x22222222222222222222222222222222222abcde" as Address;
const OTHER = "0x3333333333333333333333333333333333333333" as Address;
const NAME = "derek.cloudops.dev.sodalabs.eth";
const NOW = 1_790_000_000;

type Signer = Parameters<typeof findPatSigner>[0];
const base = (over: Partial<Signer> = {}): Signer => ({
  name: NAME,
  home: "/h/.relay",
  cmd: "relay",
  agent: null,
  user: { address: USER },
  readChain: async () => ({ missing: null, owner: USER, expiry: NOW + 30 * 86400 }),
  readOwned: async () => {
    throw new Error("the relay should not be asked");
  },
  ...over,
});

const rejectsWith = (p: Promise<unknown>, re: RegExp) =>
  assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof UserError, "a UserError (printed as one line)");
    assert.match((err as Error).message, re);
    return true;
  });

test("names: normalized, two labels or more, nothing a path or an .env line trips on", () => {
  assert.equal(patName("  Derek.CloudOps.dev.sodalabs.eth "), NAME);
  assert.equal(patName("research.codex.derek.cloudops.dev.sodalabs.eth"), "research.codex.derek.cloudops.dev.sodalabs.eth");
  for (const bad of ["", "derek", "derek..eth", ".derek.eth", "derek.eth.", "../user.eth", "a/b.eth", "a\\b.eth", "a b.eth", "a\nb.eth"]) {
    assert.equal(patName(bad), null, JSON.stringify(bad));
  }
});

test("key: ENS decides between the agent key and the user's key", async () => {
  const agent = { address: AGENT, expiry: NOW + 3600 };
  assert.deepEqual(await findPatSigner(base()), { kind: "user", ensExpiry: NOW + 30 * 86400 });
  assert.deepEqual(
    await findPatSigner(base({ agent, readChain: async () => ({ missing: null, owner: AGENT, expiry: NOW + 7200 }) })),
    { kind: "agent", ensExpiry: NOW + 7200 },
    "the chain's expiry beats the one saved with the key",
  );
  // An agent file for a name the user's key owns (a stale file): the owner signs.
  assert.equal((await findPatSigner(base({ agent }))).kind, "user");
  // Case differences in addresses don't matter.
  assert.equal((await findPatSigner(base({ readChain: async () => ({ missing: null, owner: "0x22222222222222222222222222222222222ABCDE" as Address, expiry: 1 }) }))).kind, "user");
});

test("key: refuses clearly when no key here owns the name", async () => {
  await rejectsWith(findPatSigner(base({ readChain: async () => ({ missing: null, owner: OTHER, expiry: NOW + 60 }) })), /No key in \/h\/\.relay owns derek\.cloudops\.dev\.sodalabs\.eth: it belongs to 0x3333.*your key is 0x2222/);
  await rejectsWith(findPatSigner(base({ readChain: async () => ({ missing: NAME, owner: null, expiry: null }) })), /is not registered on ENS/);
  await rejectsWith(
    findPatSigner(base({ agent: { address: AGENT, expiry: null }, readChain: async () => ({ missing: NAME, owner: null, expiry: null }) })),
    /not registered on ENS.*relay login creates your agent again/,
  );
  await rejectsWith(
    findPatSigner(base({ readChain: async () => ({ missing: "cloudops.dev.sodalabs.eth", owner: null, expiry: null }) })),
    /can't be reached: cloudops\.dev\.sodalabs\.eth is not registered/,
  );
  await rejectsWith(findPatSigner(base({ user: null })), /there are no keys there\. Run relay init/);
});

test("key: when ENS can't be read, an agent key trusts its file and the user's key asks the relay", async () => {
  const down = async () => {
    throw new UserError("Could not reach the Sepolia RPC at http://127.0.0.1:9 (fetch failed).");
  };
  const agentPick = await findPatSigner(base({ agent: { address: AGENT, expiry: NOW + 600 }, readChain: down }));
  assert.equal(agentPick.kind, "agent");
  assert.equal(agentPick.ensExpiry, NOW + 600);
  assert.match(agentPick.warning ?? "", /could not read ENS \(Could not reach the Sepolia RPC/);

  const listed = await findPatSigner(base({ readChain: down, readOwned: async () => [{ name: NAME, expiry: NOW + 900 }] }));
  assert.deepEqual([listed.kind, listed.ensExpiry], ["user", NOW + 900]);
  assert.match(listed.warning ?? "", /the relay says your key owns/);

  await rejectsWith(findPatSigner(base({ readChain: down, readOwned: async () => [{ name: "emma.cloudops.dev.sodalabs.eth", expiry: null }] })), /the relay lists emma\.cloudops\.dev\.sodalabs\.eth for your key/);
  await rejectsWith(findPatSigner(base({ readChain: down, readOwned: async () => [] })), /the relay lists no names/);
  await rejectsWith(
    findPatSigner(base({ readChain: down, readOwned: async () => Promise.reject(new UserError("Could not reach the relay")) })),
    /Could not check who owns .*nor could the relay \(Could not reach the relay\)/,
  );
});

test("expiry: the first of the name's expiry, --hours and the relay's limit", () => {
  const day = DEFAULT_MAX_TOKEN_TTL_SEC;
  // Defaults: 24 h asked, 24 h allowed; the relay's limit (less the margin) comes first.
  assert.equal(PAT_DEFAULT_HOURS, 24);
  assert.deepEqual(patExpiry({ now: NOW, ensExpiry: NOW + 365 * 86400, hours: 24, maxTtlSec: day }), { exp: NOW + day - TOKEN_TTL_MARGIN_SEC, by: "relay" });
  assert.deepEqual(patExpiry({ now: NOW, ensExpiry: NOW + 365 * 86400, hours: 2, maxTtlSec: day }), { exp: NOW + 7200, by: "hours" });
  assert.deepEqual(patExpiry({ now: NOW, ensExpiry: NOW + 365 * 86400, hours: 0.5, maxTtlSec: day }), { exp: NOW + 1800, by: "hours" });
  assert.deepEqual(patExpiry({ now: NOW, ensExpiry: NOW + 300, hours: 2, maxTtlSec: day }), { exp: NOW + 300, by: "name" });
  assert.deepEqual(patExpiry({ now: NOW, ensExpiry: null, hours: 168, maxTtlSec: 7 * day }), { exp: NOW + 7 * day - TOKEN_TTL_MARGIN_SEC, by: "relay" });
  assert.deepEqual(patExpiry({ now: NOW, ensExpiry: null, hours: 48, maxTtlSec: 7 * day }), { exp: NOW + 48 * 3600, by: "hours" });
  // A tie goes to the name.
  assert.equal(patExpiry({ now: NOW, ensExpiry: NOW + 3600, hours: 1, maxTtlSec: day }).by, "name");
});

test("output: exactly the five .env lines, the same PAT twice", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const exp = NOW + 7200;
  const token = await createToken(account, { name: NAME, iat: NOW, exp, aud: "https://relay.derek2403.win" });
  const lines = patEnvLines({ name: NAME, base: "https://relay.derek2403.win", token, exp });
  assert.deepEqual(lines, [
    `# Keyless Relay PAT for ${NAME} · expires ${isoTime(exp)} · https://relay.derek2403.win`,
    "RELAY_BASE_URL=https://relay.derek2403.win/v1",
    `RELAY_API_KEY=${token}`,
    "OPENAI_BASE_URL=https://relay.derek2403.win/v1/openai",
    `OPENAI_API_KEY=${token}`,
  ]);
  assert.equal(isoTime(exp), new Date(exp * 1000).toISOString().replace(".000Z", "Z"));
  assert.match(isoTime(exp), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // Every value is safe unquoted in an .env file or a shell (`set -a; . ./.env`).
  for (const line of lines.slice(1)) assert.match(line, /^[A-Z_]+=[A-Za-z0-9._:/-]+$/);
  // The PAT is an ordinary relay token for the name, bound to the relay.
  const { payload, signer } = await verifyToken(token, NOW + 1, { audiences: ["https://relay.derek2403.win"] });
  assert.equal(signer, account.address);
  assert.deepEqual([payload.name, payload.exp, payload.aud], [NAME, exp, "https://relay.derek2403.win"]);
  assert.equal(parseToken(lines[2].slice("RELAY_API_KEY=".length)).payload.name, NAME);
  // A trailing slash on the base is dropped; a local relay works too.
  assert.equal(patEnvLines({ name: NAME, base: "http://127.0.0.1:3000/", token, exp })[1], "RELAY_BASE_URL=http://127.0.0.1:3000/v1");
});

test("output: refuses a relay URL or token that would need quoting", async () => {
  const token = await createToken(privateKeyToAccount(generatePrivateKey()), { name: NAME, iat: NOW, exp: NOW + 60 });
  assert.throws(() => patEnvLines({ name: NAME, base: "https://relay.example/$(touch x)", token, exp: NOW + 60 }), UserError);
  assert.throws(() => patEnvLines({ name: NAME, base: "https://relay.example/a b", token, exp: NOW + 60 }), UserError);
  assert.throws(() => patEnvLines({ name: NAME, base: "https://relay.example", token: `${token}\nEVIL=1`, exp: NOW + 60 }));
});
