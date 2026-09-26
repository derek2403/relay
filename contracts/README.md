# Keyless Relay contracts

One small, optional contract: **SessionMinter**. It starts an agent session in one transaction instead of two.

Without it, starting a session (say `laptop.derek.eng.acme.eth`) takes two wallet pop-ups:

1. `register(...)` on your registry: the agent's name, owned by the agent's key, no roles, expiring at session end.
2. `multicall(setText..., setAddress...)` on your resolver: the agent's bundle and its address record.

`SessionMinter.startSession(registry, resolver, label, agentKey, expiry, records)` does both.

## What it will and won't do

The contract is shared by everyone and holds registrar power over every user who enables it, so it only does what
the caller could already do alone:

- The caller must hold `ROLE_REGISTRAR` on the registry's root (or `ROLE_REGISTER_RESERVED` if the label is
  reserved, which is the role the registry itself would check).
- Each record must be a `setText` or `setAddress` call. Anything else (contenthash, links, a nested multicall) is
  refused.
- The caller must hold `ROLE_SET_TEXT` / `ROLE_SET_ADDRESS` on the resolver's **root**. A caller who can only edit
  one text key (per-key delegation) is refused, because the minter could write any key.
- The agent key can't be zero. The agent gets no roles on its name, so it can't re-point, transfer or extend it.

No owner, no storage, no upgrades. Errors: `Unauthorized(target, roleBitmap)`, `RecordNotAllowed(index, selector)`,
`ZeroAgentKey()`. Event: `SessionStarted(registry, agentKey, label, expiry, sender)`.

## Enable it (once per user)

Grant the minter two roles, on your registry and on your resolver (from the wallet that owns them; add
`--rpc-url` and `--private-key` or `--account`):

```bash
cast send $MY_REGISTRY "grantRootRoles(uint256,address)" 0x1 $MINTER    # ROLE_REGISTRAR
cast send $MY_RESOLVER "grantRootRoles(uint256,address)" 0x11 $MINTER   # ROLE_SET_TEXT | ROLE_SET_ADDRESS
```

To turn it off again, call `revokeRootRoles` with the same arguments.

## Build and test

Needs [Foundry](https://getfoundry.sh). forge-std is not vendored in this repo (`foundry.toml` expects it at
`lib/forge-std`): install it once before building, either as a plain copy or as a git submodule of your own.

```bash
cd contracts
forge install foundry-rs/forge-std@v1.16.2 --no-git   # once (the version the tests were written against); or add it as a git submodule at contracts/lib/forge-std
forge build
forge test                                   # forks Sepolia through $SEPOLIA_RPC_URL or a public RPC
```

The tests use the real ENSv2 contracts on a Sepolia fork (VerifiableFactory, UserRegistry, PermissionedResolver).
To run them against a local fork instead:

```bash
anvil --fork-url https://ethereum-sepolia-rpc.publicnode.com --port 8601
forge test --fork-url http://127.0.0.1:8601
```

## Deploy

```bash
export SEPOLIA_RPC_URL=https://...           # any Sepolia RPC
PRIVATE_KEY=0x... forge script script/DeploySessionMinter.s.sol --rpc-url sepolia --broadcast
```

Then put the printed address in `.env.local` at the repo root:

```bash
NEXT_PUBLIC_SESSION_MINTER=0x...
```

## Using it from the app

`lib/relay/sessionMinter.ts` has the ABI, creation bytecode and Solidity source. It is generated; after changing
the contract, regenerate it:

```bash
forge build && node script/export-artifacts.mjs
```

The script refuses to run if `out/` was built from an older version of the source.
