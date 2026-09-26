// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

// Minimal views of the deployed ENSv2 UserRegistry and PermissionedResolver (contracts-v2@71a3b73).
interface IRegistry {
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function getStatus(uint256 anyId) external view returns (uint8);
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);
}

interface IResolver {
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function multicall(bytes[] calldata calls) external returns (bytes[] memory);
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
}

/// @title SessionMinter
/// @notice Starts an agent session in one transaction: registers `label` in the caller's registry
///         (owner = the agent key, no roles, expiring) and writes its records on the caller's resolver.
///         Shared by everyone, so it only does what the caller could already do alone.
///         Enable once: registry.grantRootRoles(ROLE_REGISTRAR, minter) and
///         resolver.grantRootRoles(ROLE_SET_TEXT | ROLE_SET_ADDRESS, minter).
contract SessionMinter {
    uint256 internal constant ROLE_REGISTRAR = 1 << 0; // registry
    uint256 internal constant ROLE_REGISTER_RESERVED = 1 << 4; // registry
    uint256 internal constant ROLE_SET_ADDRESS = 1 << 0; // resolver
    uint256 internal constant ROLE_SET_TEXT = 1 << 4; // resolver
    uint8 internal constant STATUS_RESERVED = 1;

    event SessionStarted(
        address indexed registry, address indexed agentKey, string label, uint64 expiry, address indexed sender
    );

    error Unauthorized(address target, uint256 roleBitmap);
    error RecordNotAllowed(uint256 index, bytes4 selector);
    error ZeroAgentKey();

    function startSession(
        IRegistry registry,
        IResolver resolver,
        string calldata label,
        address agentKey,
        uint64 expiry,
        bytes[] calldata records
    ) external returns (uint256 tokenId) {
        if (agentKey == address(0)) revert ZeroAgentKey();
        // Mirror the registry's own check: taking over a RESERVED label needs ROLE_REGISTER_RESERVED.
        uint256 regRole = registry.getStatus(uint256(keccak256(bytes(label)))) == STATUS_RESERVED
            ? ROLE_REGISTER_RESERVED
            : ROLE_REGISTRAR;
        if (!registry.hasRootRoles(regRole, msg.sender)) revert Unauthorized(address(registry), regRole);

        // Root roles only: a caller limited to one text key could otherwise write any key through us.
        uint256 need = 0;
        for (uint256 i; i < records.length; ++i) {
            bytes4 selector = bytes4(records[i]);
            if (selector == IResolver.setText.selector) need |= ROLE_SET_TEXT;
            else if (selector == IResolver.setAddress.selector) need |= ROLE_SET_ADDRESS;
            else revert RecordNotAllowed(i, selector);
        }
        if (need != 0 && !resolver.hasRootRoles(need, msg.sender)) revert Unauthorized(address(resolver), need);

        emit SessionStarted(address(registry), agentKey, label, expiry, msg.sender);
        // Agents get no roles on their own name: they cannot re-point, transfer or extend it.
        tokenId = registry.register(label, agentKey, address(0), address(resolver), 0, expiry);
        if (records.length != 0) resolver.multicall(records);
    }
}
