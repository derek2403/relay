// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {PolicyVault} from "../src/PolicyVault.sol";
import {RelayTestToken} from "../src/RelayTestToken.sol";
import {SafeToken} from "../src/SafeToken.sol";

contract PolicyVaultTest is Test {
    event Paid(address indexed to, uint256 amount, bytes32 indexed ref, address indexed agent);
    event RecipientSet(address indexed recipient, bool approved);
    event LimitsSet(uint256 perTxMax, uint256 periodLimit);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event OwnerTransfer(address indexed to, uint256 amount);
    event VaultPaused(address indexed by);
    event VaultUnpaused(address indexed by);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    uint256 constant STD = 1e18;
    uint256 constant PERIOD = 30 days;
    bytes32 constant REF = keccak256("prp_test");

    RelayTestToken token;
    PolicyVault vault;
    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address supplier = makeAddr("supplier");
    address stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_750_000_000);
        token = new RelayTestToken(owner);
        vault = new PolicyVault(address(token), owner, agent, 10 * STD, 100 * STD, PERIOD);
        vm.startPrank(owner);
        token.mint(address(vault), 1000 * STD);
        vault.setRecipient(supplier, true);
        vm.stopPrank();
    }

    function pay(address to, uint256 amount) internal {
        vm.prank(agent);
        vault.pay(to, amount, REF);
    }

    // ---- constructor ----

    function test_constructor() public view {
        assertEq(vault.token(), address(token));
        assertEq(vault.owner(), owner);
        assertEq(vault.agent(), agent);
        assertEq(vault.perTxMax(), 10 * STD);
        assertEq(vault.periodLimit(), 100 * STD);
        assertEq(vault.periodSeconds(), PERIOD);
        assertEq(vault.periodStart(), block.timestamp);
        assertEq(vault.periodEnd(), block.timestamp + PERIOD);
        assertEq(vault.remainingInPeriod(), 100 * STD);
        assertFalse(vault.paused());
    }

    function test_constructor_rejectsZeroValues() public {
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        new PolicyVault(address(0), owner, agent, 1, 1, 1);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        new PolicyVault(address(token), address(0), agent, 1, 1, 1);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        new PolicyVault(address(token), owner, address(0), 1, 1, 1);
        vm.expectRevert(PolicyVault.ZeroPeriod.selector);
        new PolicyVault(address(token), owner, agent, 1, 1, 0);
    }

    // ---- pay ----

    function test_pay() public {
        vm.expectEmit(address(vault));
        emit Paid(supplier, 3 * STD, REF, agent);
        pay(supplier, 3 * STD);
        assertEq(token.balanceOf(supplier), 3 * STD);
        assertEq(token.balanceOf(address(vault)), 997 * STD);
        assertEq(vault.spentInPeriod(), 3 * STD);
        assertEq(vault.remainingInPeriod(), 97 * STD);
    }

    function test_pay_onlyAgent() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotAgent.selector, owner));
        vm.prank(owner);
        vault.pay(supplier, STD, REF);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotAgent.selector, stranger));
        vm.prank(stranger);
        vault.pay(supplier, STD, REF);
    }

    function test_pay_unapprovedRecipient() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotApproved.selector, stranger));
        pay(stranger, STD);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotApproved.selector, address(0)));
        pay(address(0), STD);
    }

    function test_pay_revokedRecipient() public {
        vm.prank(owner);
        vault.setRecipient(supplier, false);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotApproved.selector, supplier));
        pay(supplier, STD);
    }

    function test_pay_zeroAmount() public {
        vm.expectRevert(PolicyVault.ZeroAmount.selector);
        pay(supplier, 0);
    }

    function test_pay_overPerTx() public {
        pay(supplier, 10 * STD); // exactly the max is fine
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.OverPerTx.selector, 10 * STD + 1, 10 * STD));
        pay(supplier, 10 * STD + 1);
    }

    function test_pay_overPeriod() public {
        for (uint256 i; i < 9; ++i) pay(supplier, 10 * STD);
        pay(supplier, 5 * STD);
        assertEq(vault.remainingInPeriod(), 5 * STD);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.OverPeriod.selector, 6 * STD, 5 * STD));
        pay(supplier, 6 * STD);
        pay(supplier, 5 * STD); // exactly the rest is fine
        assertEq(vault.remainingInPeriod(), 0);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.OverPeriod.selector, 1, 0));
        pay(supplier, 1);
    }

    function test_pay_periodRollsOver() public {
        uint256 start = vault.periodStart();
        for (uint256 i; i < 10; ++i) pay(supplier, 10 * STD);
        assertEq(vault.remainingInPeriod(), 0);

        vm.warp(start + PERIOD - 1);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.OverPeriod.selector, 1, 0));
        pay(supplier, 1);

        vm.warp(start + PERIOD);
        assertEq(vault.remainingInPeriod(), 100 * STD); // the view already sees the new period
        pay(supplier, 4 * STD);
        assertEq(vault.periodStart(), start + PERIOD);
        assertEq(vault.spentInPeriod(), 4 * STD);
        assertEq(vault.remainingInPeriod(), 96 * STD);
    }

    function test_pay_periodStartStaysAligned() public {
        uint256 start = vault.periodStart();
        pay(supplier, STD);
        // Skip two and a half periods: the new period starts at a whole multiple of PERIOD after `start`.
        vm.warp(start + 2 * PERIOD + PERIOD / 2);
        pay(supplier, 2 * STD);
        assertEq(vault.periodStart(), start + 2 * PERIOD);
        assertEq(vault.periodEnd(), start + 3 * PERIOD);
        assertEq(vault.spentInPeriod(), 2 * STD);
    }

    function test_pay_whilePaused() public {
        vm.expectEmit(address(vault));
        emit VaultPaused(owner);
        vm.prank(owner);
        vault.pause();
        assertTrue(vault.paused());
        vm.expectRevert(PolicyVault.Paused.selector);
        pay(supplier, STD);

        vm.expectEmit(address(vault));
        emit VaultUnpaused(owner);
        vm.prank(owner);
        vault.unpause();
        pay(supplier, STD);
    }

    function test_pay_insufficientVaultBalance() public {
        vm.prank(owner);
        vault.ownerTransfer(stranger, 998 * STD);
        vm.expectRevert(abi.encodeWithSelector(SafeToken.TokenCallFailed.selector, address(token)));
        pay(supplier, 3 * STD);
        assertEq(vault.spentInPeriod(), 0); // the failed payment left no trace
    }

    function test_pay_loweredLimitsApplyImmediately() public {
        pay(supplier, 10 * STD);
        vm.prank(owner);
        vault.setLimits(2 * STD, 5 * STD);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.OverPerTx.selector, 3 * STD, 2 * STD));
        pay(supplier, 3 * STD);
        // Already over the new period limit: nothing left, and remaining never underflows.
        assertEq(vault.remainingInPeriod(), 0);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.OverPeriod.selector, STD, 0));
        pay(supplier, STD);
    }

    function testFuzz_pay_neverExceedsPeriodLimit(uint256[8] memory amounts) public {
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, 10 * STD);
            vm.prank(agent);
            try vault.pay(supplier, amount, REF) {
                total += amount;
            } catch {}
        }
        assertLe(total, 100 * STD);
        assertEq(total, vault.spentInPeriod());
        assertEq(token.balanceOf(supplier), total);
    }

    // ---- owner functions ----

    function test_ownerFunctions_rejectNonOwner() public {
        address[2] memory callers = [agent, stranger];
        for (uint256 i; i < callers.length; ++i) {
            address c = callers[i];
            bytes memory err = abi.encodeWithSelector(PolicyVault.NotOwner.selector, c);
            vm.startPrank(c);
            vm.expectRevert(err);
            vault.setRecipient(stranger, true);
            vm.expectRevert(err);
            vault.setLimits(1, 1);
            vm.expectRevert(err);
            vault.setAgent(c);
            vm.expectRevert(err);
            vault.ownerTransfer(c, 1);
            vm.expectRevert(err);
            vault.pause();
            vm.expectRevert(err);
            vault.unpause();
            vm.expectRevert(err);
            vault.transferOwnership(c);
            vm.stopPrank();
        }
    }

    function test_setRecipient() public {
        vm.expectEmit(address(vault));
        emit RecipientSet(stranger, true);
        vm.prank(owner);
        vault.setRecipient(stranger, true);
        assertTrue(vault.approved(stranger));

        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.setRecipient(address(0), true);
    }

    function test_setLimits() public {
        vm.expectEmit(address(vault));
        emit LimitsSet(1, 2);
        vm.prank(owner);
        vault.setLimits(1, 2);
        assertEq(vault.perTxMax(), 1);
        assertEq(vault.periodLimit(), 2);
    }

    function test_setAgent() public {
        address next = makeAddr("next");
        vm.expectEmit(address(vault));
        emit AgentSet(agent, next);
        vm.prank(owner);
        vault.setAgent(next);
        assertEq(vault.agent(), next);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotAgent.selector, agent));
        pay(supplier, STD);

        vm.prank(next);
        vault.pay(supplier, STD, REF);
    }

    function test_setAgent_zeroDisablesPayments() public {
        vm.prank(owner);
        vault.setAgent(address(0));
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotAgent.selector, agent));
        pay(supplier, STD);
    }

    function test_ownerTransfer_ignoresLimitsAndRecipients() public {
        vm.expectEmit(address(vault));
        emit OwnerTransfer(stranger, 250 * STD);
        vm.prank(owner);
        vault.ownerTransfer(stranger, 250 * STD);
        assertEq(token.balanceOf(stranger), 250 * STD);
        assertEq(vault.spentInPeriod(), 0);

        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.ownerTransfer(address(0), 1);
    }

    function test_pauseTwiceAndUnpauseUnpaused() public {
        vm.expectRevert(PolicyVault.NotPaused.selector);
        vm.prank(owner);
        vault.unpause();
        vm.prank(owner);
        vault.pause();
        vm.expectRevert(PolicyVault.Paused.selector);
        vm.prank(owner);
        vault.pause();
    }

    function test_transferOwnership() public {
        address next = makeAddr("next");
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.transferOwnership(address(0));

        vm.expectEmit(address(vault));
        emit OwnershipTransferred(owner, next);
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.owner(), next);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotOwner.selector, owner));
        vm.prank(owner);
        vault.pause();
        vm.prank(next);
        vault.pause();
    }
}
