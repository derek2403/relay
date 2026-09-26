// Enhanced Access Control role bitmaps, mirrored from contracts-v2:
//   src/access-control/libraries/EACBaseRolesLib.sol
//   src/registry/libraries/RegistryRolesLib.sol
//   src/resolver/libraries/PermissionedResolverLib.sol
//
// A bitmap is 64 nybbles: nybbles 0-31 are regular roles, nybbles 32-63 are
// their admin counterparts (role << 128). See /ensv2/enhanced-access-control.

export const ROOT_RESOURCE = 0n;

export const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;
export const ADMIN_ROLES = 0x1111111111111111111111111111111100000000000000000000000000000000n;

export const adminOf = (role: bigint) => role << 128n;

export type RoleScope = "root" | "token" | "root-or-token" | "argument" | "root-or-argument";

export type RoleInfo = {
  name: string;
  value: bigint;
  nybble: number;
  scope: RoleScope;
  description: string;
};

const role = (name: string, nybble: number, scope: RoleScope, description: string): RoleInfo => ({
  name,
  value: 1n << BigInt(nybble * 4),
  nybble,
  scope,
  description,
});

export const RegistryRoles = {
  ROLE_REGISTRAR: 1n << 0n,
  ROLE_REGISTRAR_ADMIN: (1n << 0n) << 128n,
  ROLE_REGISTER_RESERVED: 1n << 4n,
  ROLE_REGISTER_RESERVED_ADMIN: (1n << 4n) << 128n,
  ROLE_SET_PARENT: 1n << 8n,
  ROLE_SET_PARENT_ADMIN: (1n << 8n) << 128n,
  ROLE_UNREGISTER: 1n << 12n,
  ROLE_UNREGISTER_ADMIN: (1n << 12n) << 128n,
  ROLE_RENEW: 1n << 16n,
  ROLE_RENEW_ADMIN: (1n << 16n) << 128n,
  ROLE_SET_SUBREGISTRY: 1n << 20n,
  ROLE_SET_SUBREGISTRY_ADMIN: (1n << 20n) << 128n,
  ROLE_SET_RESOLVER: 1n << 24n,
  ROLE_SET_RESOLVER_ADMIN: (1n << 24n) << 128n,
  ROLE_CAN_TRANSFER_ADMIN: (1n << 28n) << 128n,
  ROLE_WAS_RESERVED: 1n << 32n,
  ROLE_SET_URI: 1n << 36n,
  ROLE_SET_URI_ADMIN: (1n << 36n) << 128n,
  ROLE_CAN_NAME: 1n << 120n,
  ROLE_CAN_NAME_ADMIN: (1n << 120n) << 128n,
  ROLE_UPGRADE: 1n << 124n,
  ROLE_UPGRADE_ADMIN: (1n << 124n) << 128n,
} as const;

// Root roles that violate token emancipation (excludes ROLE_RENEW{,_ADMIN}).
export const UNEMANCIPATED_ROLE_BITMAP =
  RegistryRoles.ROLE_SET_SUBREGISTRY |
  RegistryRoles.ROLE_SET_SUBREGISTRY_ADMIN |
  RegistryRoles.ROLE_SET_RESOLVER |
  RegistryRoles.ROLE_SET_RESOLVER_ADMIN |
  RegistryRoles.ROLE_UNREGISTER |
  RegistryRoles.ROLE_UNREGISTER_ADMIN |
  RegistryRoles.ROLE_UPGRADE |
  RegistryRoles.ROLE_UPGRADE_ADMIN;

// Roles the ETH Registrar grants a name owner at registration; also used by
// the SimpleSubnameRegistrar tutorial.
export const REGISTRATION_ROLE_BITMAP =
  RegistryRoles.ROLE_SET_SUBREGISTRY |
  RegistryRoles.ROLE_SET_SUBREGISTRY_ADMIN |
  RegistryRoles.ROLE_SET_RESOLVER |
  RegistryRoles.ROLE_SET_RESOLVER_ADMIN |
  RegistryRoles.ROLE_CAN_TRANSFER_ADMIN;

export const ResolverRoles = {
  ROLE_SET_ADDRESS: 1n << 0n,
  ROLE_SET_ADDRESS_ADMIN: (1n << 0n) << 128n,
  ROLE_SET_TEXT: 1n << 4n,
  ROLE_SET_TEXT_ADMIN: (1n << 4n) << 128n,
  ROLE_SET_CONTENTHASH: 1n << 8n,
  ROLE_SET_CONTENTHASH_ADMIN: (1n << 8n) << 128n,
  ROLE_SET_ABI: 1n << 12n,
  ROLE_SET_ABI_ADMIN: (1n << 12n) << 128n,
  ROLE_SET_INTERFACE: 1n << 16n,
  ROLE_SET_INTERFACE_ADMIN: (1n << 16n) << 128n,
  ROLE_SET_NAME: 1n << 20n,
  ROLE_SET_NAME_ADMIN: (1n << 20n) << 128n,
  ROLE_SET_DATA: 1n << 24n,
  ROLE_SET_DATA_ADMIN: (1n << 24n) << 128n,
  ROLE_LINK: 1n << 28n,
  ROLE_LINK_ADMIN: (1n << 28n) << 128n,
  ROLE_CAN_NAME: 1n << 120n,
  ROLE_CAN_NAME_ADMIN: (1n << 120n) << 128n,
  ROLE_UPGRADE: 1n << 124n,
  ROLE_UPGRADE_ADMIN: (1n << 124n) << 128n,
} as const;

// Regular (non-admin) roles with metadata, for bitmap composers and decoders.
// Admin variants live at nybble + 32.
export const REGISTRY_ROLE_TABLE: RoleInfo[] = [
  role("ROLE_REGISTRAR", 0, "root", "Register and reserve new names"),
  role("ROLE_REGISTER_RESERVED", 1, "root", "Promote a RESERVED name to REGISTERED"),
  role("ROLE_SET_PARENT", 2, "root", "Set the registry's parent pointer"),
  role("ROLE_UNREGISTER", 3, "root-or-token", "Unregister names"),
  role("ROLE_RENEW", 4, "root-or-token", "Extend name expiry"),
  role("ROLE_SET_SUBREGISTRY", 5, "root-or-token", "Change a name's child registry"),
  role("ROLE_SET_RESOLVER", 6, "root-or-token", "Change a name's resolver"),
  role("ROLE_CAN_TRANSFER", 7, "root-or-token", "Transfer the token (admin nybble only)"),
  role("ROLE_WAS_RESERVED", 8, "token", "Tag: registered via ROLE_REGISTER_RESERVED"),
  role("ROLE_SET_URI", 9, "root", "Set the registry token URI"),
  role("ROLE_CAN_NAME", 30, "root", "Contract naming"),
  role("ROLE_UPGRADE", 31, "root", "UUPS proxy upgrades"),
];

export const RESOLVER_ROLE_TABLE: RoleInfo[] = [
  role("ROLE_SET_ADDRESS", 0, "root-or-argument", "Set address records"),
  role("ROLE_SET_TEXT", 1, "root-or-argument", "Set text records"),
  role("ROLE_SET_CONTENTHASH", 2, "root", "Set the contenthash record"),
  role("ROLE_SET_ABI", 3, "root-or-argument", "Set ABI records"),
  role("ROLE_SET_INTERFACE", 4, "root-or-argument", "Set interface implementer records"),
  role("ROLE_SET_NAME", 5, "root", "Set the reverse name record"),
  role("ROLE_SET_DATA", 6, "root-or-argument", "Set data records"),
  role("ROLE_LINK", 7, "root", "Link records between names"),
  role("ROLE_CAN_NAME", 30, "root", "Contract naming"),
  role("ROLE_UPGRADE", 31, "root", "UUPS proxy upgrades"),
];

/** Assignee count (0-15) stored in a given nybble of a packed counts value. */
export const nybbleAt = (value: bigint, nybble: number) => Number((value >> BigInt(nybble * 4)) & 0xfn);

/** Names of every role (regular and admin) set in `bitmap`, using `table`. */
export function decodeRoles(bitmap: bigint, table: RoleInfo[]): string[] {
  const out: string[] = [];
  for (const r of table) {
    // ROLE_CAN_TRANSFER only exists as an admin role.
    if (r.name !== "ROLE_CAN_TRANSFER" && nybbleAt(bitmap, r.nybble)) out.push(r.name);
    if (r.name !== "ROLE_WAS_RESERVED" && nybbleAt(bitmap, r.nybble + 32)) out.push(`${r.name}_ADMIN`);
  }
  return out;
}

export const toHex256 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
