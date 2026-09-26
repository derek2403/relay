// Friendly permission catalog on top of ENSv2 Enhanced Access Control.
//
// EAC has no on-chain "groups" or "policies": it stores a role bitmap per
// (resource, account). Here a policy is a named set of permissions on one kind
// of target, and a group is a named list of addresses; applying a policy to a
// group grants the roles to every member on-chain.

import { type Address, keccak256, stringToBytes } from "viem";

import { RegistryRoles, ResolverRoles, nybbleAt } from "./roles";

export type Target = "name" | "resolver" | "subnames";

export type Permission = { label: string; value: bigint };

export const TARGETS: Record<Target, { label: string; description: string; permissions: Permission[] }> = {
  name: {
    label: "A name",
    description: "Roles on one name in its registry. Granting changes the name's token ID.",
    permissions: [
      { label: "Change the resolver", value: RegistryRoles.ROLE_SET_RESOLVER },
      { label: "Change the subname registry", value: RegistryRoles.ROLE_SET_SUBREGISTRY },
    ],
  },
  resolver: {
    label: "My resolver (records)",
    description: "Roles on your resolver. They apply to every name that uses it.",
    permissions: [
      { label: "Set addresses", value: ResolverRoles.ROLE_SET_ADDRESS },
      { label: "Set text records", value: ResolverRoles.ROLE_SET_TEXT },
      { label: "Set content hash", value: ResolverRoles.ROLE_SET_CONTENTHASH },
      { label: "Set ABI", value: ResolverRoles.ROLE_SET_ABI },
      { label: "Set interfaces", value: ResolverRoles.ROLE_SET_INTERFACE },
      { label: "Set data records", value: ResolverRoles.ROLE_SET_DATA },
      { label: "Set reverse name", value: ResolverRoles.ROLE_SET_NAME },
      { label: "Link records", value: ResolverRoles.ROLE_LINK },
    ],
  },
  subnames: {
    label: "A name's subname registry",
    description: "Registry-wide roles on the subname registry of a name.",
    permissions: [
      { label: "Create subnames", value: RegistryRoles.ROLE_REGISTRAR },
      { label: "Renew subnames", value: RegistryRoles.ROLE_RENEW },
      { label: "Delete subnames", value: RegistryRoles.ROLE_UNREGISTER },
      { label: "Change any subname's resolver", value: RegistryRoles.ROLE_SET_RESOLVER },
      { label: "Change any subname's registry", value: RegistryRoles.ROLE_SET_SUBREGISTRY },
    ],
  },
};

export type Policy = {
  id: string;
  name: string;
  target: Target;
  /** Role bitmap as a decimal string (localStorage-safe). */
  roles: string;
  /** Can the grantee pass these permissions on (admin roles)? */
  delegate: boolean;
  /** Resolver only: restrict to a single text record key. */
  textKey?: string;
  builtin?: boolean;
};

export type Group = { id: string; name: string; members: Address[] };

export const PRESET_POLICIES: Policy[] = [
  {
    id: "preset-record-editor",
    name: "Record editor",
    target: "resolver",
    roles: (ResolverRoles.ROLE_SET_ADDRESS | ResolverRoles.ROLE_SET_TEXT | ResolverRoles.ROLE_SET_CONTENTHASH).toString(),
    delegate: false,
    builtin: true,
  },
  {
    id: "preset-avatar-only",
    name: "Avatar only",
    target: "resolver",
    roles: ResolverRoles.ROLE_SET_TEXT.toString(),
    delegate: false,
    textKey: "avatar",
    builtin: true,
  },
  {
    id: "preset-resolver-manager",
    name: "Resolver manager",
    target: "name",
    roles: RegistryRoles.ROLE_SET_RESOLVER.toString(),
    delegate: false,
    builtin: true,
  },
  {
    id: "preset-subname-manager",
    name: "Subname manager",
    target: "subnames",
    roles: (RegistryRoles.ROLE_REGISTRAR | RegistryRoles.ROLE_RENEW | RegistryRoles.ROLE_UNREGISTER).toString(),
    delegate: false,
    builtin: true,
  },
];

/**
 * Whether grantees can be allowed to re-delegate. PermissionedRegistry only
 * lets admin roles be granted registry-wide, never on an individual name, and
 * key-scoped resolver grants carry no admin role.
 */
export const canDelegate = (target: Target, textKey?: string) => target !== "name" && !textKey;

/** The bitmap to grant: regular roles, plus their admin variants when delegating. */
export const policyBitmap = (p: Policy) => {
  const roles = BigInt(p.roles);
  return p.delegate && canDelegate(p.target, p.textKey) ? roles | (roles << 128n) : roles;
};

/** EAC resource for a single text key on a PermissionedResolver (PermissionedResolverLib.resource(string)). */
export const textKeyResource = (key: string) => BigInt(keccak256(stringToBytes(key)));

/** Human-readable permissions contained in a role bitmap for a target. */
export function describeRoles(target: Target, bitmap: bigint): string[] {
  const out: string[] = [];
  for (const p of TARGETS[target].permissions) {
    const nybble = (p.value.toString(2).length - 1) / 4; // each role is 1 << (nybble * 4)
    const has = nybbleAt(bitmap, nybble) > 0;
    const admin = nybbleAt(bitmap, nybble + 32) > 0;
    if (has || admin) out.push(admin ? `${p.label} (can delegate)` : p.label);
  }
  return out;
}

export function describePolicy(p: Policy): string {
  const perms = describeRoles(p.target, BigInt(p.roles));
  const scope = p.textKey ? ` (only "${p.textKey}")` : "";
  return `${perms.join(", ")}${scope}${p.delegate && canDelegate(p.target, p.textKey) ? ", can delegate" : ""}`;
}
