// Verifiable Factory helpers (see /ensv2/verifiable-factory): salt schemes,
// initializer encoding and off-chain CREATE2 address prediction for the
// per-account PermissionedResolver and per-name UserRegistry proxies.

import {
  type Address,
  type Hex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  keccak256,
  parseAbi,
  parseEventLogs,
  stringToHex,
  type Log,
} from "viem";

import { ENSV2_SEPOLIA } from "./deployments";
import { ALL_ROLES } from "./roles";

export const VERIFIABLE_FACTORY = ENSV2_SEPOLIA.VerifiableFactory.address;
export const PERMISSIONED_RESOLVER_IMPL = ENSV2_SEPOLIA.PermissionedResolverImpl.address;
export const USER_REGISTRY_IMPL = ENSV2_SEPOLIA.UserRegistryImpl.address;

export const verifiableFactoryAbi = parseAbi([
  "function deployProxy(address implementation, uint256 salt, bytes data) returns (address)",
  "function proxyLogic() view returns (address)",
  "function verifyContract(address proxy) view returns (address implementation)",
  "event ProxyDeployed(address indexed sender, address indexed proxyAddress, uint256 salt, address implementation)",
]);

export const resolverInitAbi = parseAbi([
  "function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)",
]);

export const registryInitAbi = parseAbi(["function initialize((address account, uint256 roleBitmap)[] grants)"]);

export type RoleGrant = { account: Address; roleBitmap: bigint };

/** Salt scheme for per-account resolvers: keccak256("OwnedResolver", owner, version). */
export const resolverSalt = (owner: Address, version = 0n): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [keccak256(stringToHex("OwnedResolver")), owner, version],
      ),
    ),
  );

/** Salt scheme for per-name subname registries: keccak256("UserRegistry", namehash, version). */
export const registrySalt = (node: Hex, version = 0n): bigint =>
  BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
        [keccak256(stringToHex("UserRegistry")), node, version],
      ),
    ),
  );

export const encodeResolverInit = (grants: RoleGrant[], calls: Hex[] = []): Hex =>
  encodeFunctionData({ abi: resolverInitAbi, functionName: "initialize", args: [grants, calls] });

export const encodeRegistryInit = (grants: RoleGrant[]): Hex =>
  encodeFunctionData({ abi: registryInitAbi, functionName: "initialize", args: [grants] });

/** Grants every role and admin role to `account` (what the docs' examples use). */
export const allRolesTo = (account: Address): RoleGrant[] => [{ account, roleBitmap: ALL_ROLES }];

/**
 * CREATE2 address of a proxy the factory would deploy for `deployer` with
 * `salt`. `proxyLogic` comes from the factory's `proxyLogic()` getter.
 */
export function predictProxyAddress({
  factory = VERIFIABLE_FACTORY,
  proxyLogic,
  deployer,
  salt,
}: {
  factory?: Address;
  proxyLogic: Address;
  deployer: Address;
  salt: bigint;
}): Address {
  const outerSalt = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [deployer, salt]));
  const initCode = concat([
    "0x3d604d80600a3d3981f3363d3d373d3d3d363d73",
    proxyLogic,
    "0x5af43d82803e903d91602b57fd5bf3",
    outerSalt,
  ]);
  return getCreate2Address({ from: factory, salt: outerSalt, bytecodeHash: keccak256(initCode) });
}

/** Extracts the deployed proxy address from a deployProxy receipt. */
export function proxyAddressFromLogs(logs: Log[]): Address | undefined {
  const [log] = parseEventLogs({ abi: verifiableFactoryAbi, eventName: "ProxyDeployed", logs });
  return log?.args.proxyAddress;
}
