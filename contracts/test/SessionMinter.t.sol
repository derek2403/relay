// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {IRegistry, IResolver, SessionMinter} from "../src/SessionMinter.sol";

// Runs against the real ENSv2 contracts on a Sepolia fork (see README).

struct Grant {
    address account;
    uint256 roleBitmap;
}

struct State {
    uint8 status;
    uint64 expiry;
    address latestOwner;
    uint256 tokenId;
    uint256 resource;
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IUserRegistry is IRegistry {
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function getState(uint256 anyId) external view returns (State memory);
    function roles(uint256 anyId, address account) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IPermissionedResolver is IResolver {
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
    function setContenthash(bytes calldata name, bytes calldata hash) external;
}

interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

interface IAddrResolver {
    function addr(bytes32 node) external view returns (address);
}

contract SessionMinterTest is Test {
    // ENSv2 on Sepolia (lib/ens/deployments.ts, contracts-v2@71a3b73).
    IVerifiableFactory constant FACTORY = IVerifiableFactory(0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C);
    address constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address constant PERMISSIONED_RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    string constant DEFAULT_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

    uint256 constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant ROLE_REGISTRAR = 1 << 0;
    uint256 constant ROLE_REGISTER_RESERVED = 1 << 4;
    uint256 constant ROLE_SET_ADDRESS = 1 << 0;
    uint256 constant ROLE_SET_TEXT = 1 << 4;

    string constant PARENT = "derek.eng.acme.eth";
    string constant LABEL = "laptop";
    string constant AGENT_NAME = "laptop.derek.eng.acme.eth";

    address user = makeAddr("keyless-relay-test-user");
    address stranger = makeAddr("keyless-relay-test-stranger");
    address agent = makeAddr("keyless-relay-test-agent");

    SessionMinter minter;
    IUserRegistry registry;
    IPermissionedResolver resolver;
    uint64 expiry;
    bytes dnsName;
    bytes32 node;

    function setUp() public {
        if (block.chainid != 11155111) {
            vm.createSelectFork(vm.envOr("SEPOLIA_RPC_URL", string(DEFAULT_RPC)));
        }
        require(address(FACTORY).code.length > 0, "not a Sepolia fork: VerifiableFactory missing");

        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(user, ALL_ROLES);

        // Same salts and initializers as lib/ens/factory.ts.
        vm.startPrank(user);
        resolver = IPermissionedResolver(
            FACTORY.deployProxy(
                PERMISSIONED_RESOLVER_IMPL,
                uint256(keccak256(abi.encode(keccak256("OwnedResolver"), user, uint256(0)))),
                abi.encodeWithSignature("initialize((address,uint256)[],bytes[])", grants, new bytes[](0))
            )
        );
        registry = IUserRegistry(
            FACTORY.deployProxy(
                USER_REGISTRY_IMPL,
                uint256(keccak256(abi.encode(keccak256("UserRegistry"), namehash(PARENT), uint256(0)))),
                abi.encodeWithSignature("initialize((address,uint256)[])", grants)
            )
        );
        vm.stopPrank();

        minter = new SessionMinter();
        enableMinter(ROLE_REGISTRAR);

        expiry = uint64(block.timestamp + 8 hours);
        dnsName = dnsEncode(AGENT_NAME);
        node = namehash(AGENT_NAME);
    }

    // ---------------------------------------------------------------- happy path

    function test_startSession_registersAgentAndWritesBundle() public {
        vm.prank(user);
        uint256 tokenId = minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());

        State memory s = registry.getState(uint256(keccak256(bytes(LABEL))));
        assertEq(s.status, 2, "registered");
        assertEq(s.latestOwner, agent);
        assertEq(s.expiry, expiry);
        assertEq(s.tokenId, tokenId);
        assertEq(registry.ownerOf(tokenId), agent);
        assertEq(registry.getResolver(LABEL), address(resolver));

        // Nobody gets roles on the agent's name: not the agent, not the minter.
        assertEq(registry.roles(s.resource, agent), 0, "agent roles");
        assertEq(registry.roles(s.resource, address(minter)), 0, "minter roles");

        assertEq(text("relay.keys"), "claude,github");
        assertEq(text("relay.cap.claude"), "5");
        assertEq(text("relay.period"), "total");
        bytes memory a = resolver.resolve(dnsName, abi.encodeCall(IAddrResolver.addr, (node)));
        assertEq(abi.decode(a, (address)), agent, "addr record");
    }

    function test_startSession_bundleReadsInOneCallLikeTheRelay() public {
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());

        bytes[] memory reads = new bytes[](2);
        reads[0] = abi.encodeCall(ITextResolver.text, (node, "relay.keys"));
        reads[1] = abi.encodeCall(ITextResolver.text, (node, "relay.cap.claude"));
        bytes memory out = resolver.resolve(dnsName, abi.encodeCall(IResolver.multicall, (reads)));
        bytes[] memory values = abi.decode(out, (bytes[]));
        assertEq(abi.decode(values[0], (string)), "claude,github");
        assertEq(abi.decode(values[1], (string)), "5");
    }

    function test_startSession_emitsSessionStarted() public {
        vm.expectEmit(true, true, true, true, address(minter));
        emit SessionMinter.SessionStarted(address(registry), agent, LABEL, expiry, user);
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());
    }

    function test_startSession_withoutRecordsNeedsNoResolverRole() public {
        vm.prank(user);
        registry.grantRootRoles(ROLE_REGISTRAR, stranger);

        vm.prank(stranger);
        minter.startSession(registry, resolver, LABEL, agent, expiry, new bytes[](0));
        assertEq(registry.getState(uint256(keccak256(bytes(LABEL)))).latestOwner, agent);
        assertEq(text("relay.keys"), "", "nothing written");
    }

    function test_startSession_sameLabelAgainAfterExpiry() public {
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());
        uint256 oldResource = registry.getState(uint256(keccak256(bytes(LABEL)))).resource;

        vm.warp(expiry + 1);
        address nextAgent = makeAddr("keyless-relay-test-agent-2");
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, nextAgent, expiry + 8 hours, bundle());

        State memory s = registry.getState(uint256(keccak256(bytes(LABEL))));
        assertEq(s.latestOwner, nextAgent);
        assertTrue(s.resource != oldResource, "new session, new resource");
    }

    // ---------------------------------------------------------------- the caller's own permissions

    function test_revert_callerWithoutRegistrarRole() public {
        vm.prank(user);
        resolver.grantRootRoles(ROLE_SET_TEXT | ROLE_SET_ADDRESS, stranger);

        vm.expectRevert(abi.encodeWithSelector(SessionMinter.Unauthorized.selector, address(registry), ROLE_REGISTRAR));
        vm.prank(stranger);
        minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());
    }

    function test_revert_callerWithoutSetTextOnResolver() public {
        vm.prank(user);
        registry.grantRootRoles(ROLE_REGISTRAR, stranger);

        // The minter holds ROLE_SET_TEXT on this resolver; the caller does not.
        bytes[] memory records = new bytes[](1);
        records[0] = abi.encodeCall(IResolver.setText, (dnsName, "relay.keys", "claude"));
        vm.expectRevert(abi.encodeWithSelector(SessionMinter.Unauthorized.selector, address(resolver), ROLE_SET_TEXT));
        vm.prank(stranger);
        minter.startSession(registry, resolver, LABEL, agent, expiry, records);
    }

    function test_revert_callerWithoutSetAddressOnResolver() public {
        vm.startPrank(user);
        registry.grantRootRoles(ROLE_REGISTRAR, stranger);
        resolver.grantRootRoles(ROLE_SET_TEXT, stranger);
        vm.stopPrank();

        vm.expectRevert(
            abi.encodeWithSelector(
                SessionMinter.Unauthorized.selector, address(resolver), ROLE_SET_TEXT | ROLE_SET_ADDRESS
            )
        );
        vm.prank(stranger);
        minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());
    }

    function test_revert_callerWithOnlyOneKeyNeedsRootRole() public {
        vm.startPrank(user);
        registry.grantRootRoles(ROLE_REGISTRAR, stranger);
        // Per-key delegation: stranger may edit only "relay.cap.claude".
        resolver.grantSetterRoles(abi.encodeCall(IResolver.setText, (hex"00", "relay.cap.claude", "")), stranger);
        vm.stopPrank();

        bytes[] memory records = new bytes[](1);
        records[0] = abi.encodeCall(IResolver.setText, (dnsName, "relay.cap.claude", "1"));
        vm.expectRevert(abi.encodeWithSelector(SessionMinter.Unauthorized.selector, address(resolver), ROLE_SET_TEXT));
        vm.prank(stranger);
        minter.startSession(registry, resolver, LABEL, agent, expiry, records);
    }

    function test_revert_reservedLabelNeedsRegisterReserved() public {
        // Even if a user over-grants the minter, it only uses what the caller holds.
        enableMinter(ALL_ROLES);
        vm.startPrank(user);
        registry.register(LABEL, address(0), address(0), address(0), 0, expiry); // reserve
        registry.grantRootRoles(ROLE_REGISTRAR, stranger);
        vm.stopPrank();
        assertEq(registry.getStatus(uint256(keccak256(bytes(LABEL)))), 1, "reserved");

        vm.expectRevert(
            abi.encodeWithSelector(SessionMinter.Unauthorized.selector, address(registry), ROLE_REGISTER_RESERVED)
        );
        vm.prank(stranger);
        minter.startSession(registry, resolver, LABEL, agent, expiry, new bytes[](0));
    }

    // ---------------------------------------------------------------- record allowlist

    function test_revert_disallowedSelector() public {
        bytes[] memory records = new bytes[](2);
        records[0] = abi.encodeCall(IResolver.setText, (dnsName, "relay.keys", "claude"));
        records[1] = abi.encodeCall(IPermissionedResolver.setContenthash, (dnsName, hex"e301"));
        vm.expectRevert(
            abi.encodeWithSelector(
                SessionMinter.RecordNotAllowed.selector, 1, IPermissionedResolver.setContenthash.selector
            )
        );
        vm.prank(user); // has every role, still refused
        minter.startSession(registry, resolver, LABEL, agent, expiry, records);
    }

    function test_revert_nestedMulticall() public {
        bytes[] memory inner = new bytes[](1);
        inner[0] = abi.encodeCall(IPermissionedResolver.setContenthash, (dnsName, hex"e301"));
        bytes[] memory records = new bytes[](1);
        records[0] = abi.encodeCall(IResolver.multicall, (inner));
        vm.expectRevert(
            abi.encodeWithSelector(SessionMinter.RecordNotAllowed.selector, 0, IResolver.multicall.selector)
        );
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, agent, expiry, records);
    }

    function test_revert_shortRecord() public {
        bytes[] memory records = new bytes[](1);
        records[0] = hex"10f1"; // 2 bytes: zero-padded to 0x10f10000, not a setter
        vm.expectRevert(abi.encodeWithSelector(SessionMinter.RecordNotAllowed.selector, 0, bytes4(0x10f10000)));
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, agent, expiry, records);
    }

    // ---------------------------------------------------------------- inputs

    function test_revert_zeroAgentKey() public {
        vm.expectRevert(SessionMinter.ZeroAgentKey.selector);
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, address(0), expiry, bundle());
    }

    function test_revert_pastExpiry() public {
        uint64 past = uint64(block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSignature("CannotSetPastExpiry(uint64)", past));
        vm.prank(user);
        minter.startSession(registry, resolver, LABEL, agent, past, bundle());
    }

    function test_revert_labelAlreadyRegistered() public {
        vm.startPrank(user);
        minter.startSession(registry, resolver, LABEL, agent, expiry, bundle());
        vm.expectRevert(abi.encodeWithSignature("LabelAlreadyRegistered(string)", LABEL));
        minter.startSession(registry, resolver, LABEL, stranger, expiry, bundle());
        vm.stopPrank();
    }

    function test_revert_minterNotEnabled() public {
        SessionMinter fresh = new SessionMinter();
        vm.expectRevert(
            abi.encodeWithSignature(
                "EACUnauthorizedAccountRoles(uint256,uint256,address)", 0, ROLE_REGISTRAR, address(fresh)
            )
        );
        vm.prank(user);
        fresh.startSession(registry, resolver, LABEL, agent, expiry, bundle());
    }

    // ---------------------------------------------------------------- helpers

    function test_nameHelpers() public pure {
        assertEq(dnsEncode("laptop.acme.eth"), hex"066c6170746f700461636d650365746800");
        assertEq(dnsEncode(""), hex"00");
        assertEq(namehash("eth"), 0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae);
        assertEq(namehash(AGENT_NAME), vm.ensNamehash(AGENT_NAME));
        assertEq(namehash(""), bytes32(0));
    }

    /// One user's setup: let the minter act on their registry and resolver.
    function enableMinter(uint256 registryRoles) internal {
        vm.startPrank(user);
        registry.grantRootRoles(registryRoles, address(minter));
        resolver.grantRootRoles(ROLE_SET_TEXT | ROLE_SET_ADDRESS, address(minter));
        vm.stopPrank();
    }

    /// An agent bundle as the app writes it (lib/relay/bundle.ts) plus the agent's ETH address.
    function bundle() internal view returns (bytes[] memory records) {
        records = new bytes[](4);
        records[0] = abi.encodeCall(IResolver.setText, (dnsName, "relay.keys", "claude,github"));
        records[1] = abi.encodeCall(IResolver.setText, (dnsName, "relay.cap.claude", "5"));
        records[2] = abi.encodeCall(IResolver.setText, (dnsName, "relay.period", "total"));
        records[3] = abi.encodeCall(IResolver.setAddress, (dnsName, 60, abi.encodePacked(agent)));
    }

    function text(string memory key) internal view returns (string memory) {
        return abi.decode(resolver.resolve(dnsName, abi.encodeCall(ITextResolver.text, (node, key))), (string));
    }

    /// "a.bc" -> 0x01 61 02 6263 00
    function dnsEncode(string memory name) internal pure returns (bytes memory out) {
        bytes memory s = bytes(name);
        if (s.length == 0) return hex"00";
        out = new bytes(s.length + 2);
        uint256 start;
        for (uint256 i; i <= s.length; ++i) {
            if (i == s.length || s[i] == ".") {
                require(i > start && i - start < 256, "bad label");
                out[start] = bytes1(uint8(i - start));
                for (uint256 j = start; j < i; ++j) {
                    out[j + 1] = s[j];
                }
                start = i + 1;
            }
        }
    }

    function namehash(string memory name) internal pure returns (bytes32) {
        return namehashAt(dnsEncode(name), 0);
    }

    function namehashAt(bytes memory dns, uint256 offset) internal pure returns (bytes32) {
        uint256 len = uint8(dns[offset]);
        if (len == 0) return bytes32(0);
        bytes memory label = new bytes(len);
        for (uint256 i; i < len; ++i) {
            label[i] = dns[offset + 1 + i];
        }
        return keccak256(abi.encodePacked(namehashAt(dns, offset + 1 + len), keccak256(label)));
    }
}
