// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {RelayTestToken} from "../src/RelayTestToken.sol";
import {SafeToken} from "../src/SafeToken.sol";
import {SimpleEscrow} from "../src/SimpleEscrow.sol";

contract SimpleEscrowTest is Test {
    event Funded(address indexed payer, uint256 amount);
    event Released(address indexed payee, uint256 amount, address indexed by);
    event Refunded(address indexed payer, uint256 amount, address indexed by);
    event Paused(address by);
    event Unpaused(address by);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event OperatorSet(address indexed previousOperator, address indexed newOperator);

    uint256 constant AMOUNT = 5e18;

    RelayTestToken token;
    SimpleEscrow escrow;
    address tokenOwner = makeAddr("tokenOwner");
    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    address admin = makeAddr("admin"); // the human owner
    address relaySigner = makeAddr("relaySigner"); // deploys, so becomes the operator
    address stranger = makeAddr("stranger");

    function setUp() public {
        token = new RelayTestToken(tokenOwner);
        vm.prank(tokenOwner);
        token.mint(payer, 100e18);
        vm.prank(relaySigner);
        escrow = new SimpleEscrow(address(token), payer, payee, AMOUNT, admin);
    }

    function fund() internal {
        vm.startPrank(payer);
        token.approve(address(escrow), AMOUNT);
        escrow.fund();
        vm.stopPrank();
    }

    // ---- constructor ----

    function test_constructor() public view {
        assertEq(escrow.token(), address(token));
        assertEq(escrow.payer(), payer);
        assertEq(escrow.payee(), payee);
        assertEq(escrow.amount(), AMOUNT);
        assertEq(escrow.admin(), admin);
        assertEq(escrow.operator(), relaySigner);
        assertFalse(escrow.funded());
        assertFalse(escrow.released());
        assertFalse(escrow.refunded());
        assertFalse(escrow.paused());
        assertEq(escrow.pausedBy(), address(0));
    }

    function test_constructor_emitsRoles() public {
        vm.expectEmit();
        emit AdminTransferred(address(0), admin);
        vm.expectEmit();
        emit OperatorSet(address(0), relaySigner);
        vm.prank(relaySigner);
        new SimpleEscrow(address(token), payer, payee, AMOUNT, admin);
    }

    function test_constructor_rejectsZeroValues() public {
        vm.expectRevert(SimpleEscrow.ZeroAddress.selector);
        new SimpleEscrow(address(0), payer, payee, AMOUNT, admin);
        vm.expectRevert(SimpleEscrow.ZeroAddress.selector);
        new SimpleEscrow(address(token), address(0), payee, AMOUNT, admin);
        vm.expectRevert(SimpleEscrow.ZeroAddress.selector);
        new SimpleEscrow(address(token), payer, address(0), AMOUNT, admin);
        vm.expectRevert(SimpleEscrow.ZeroAddress.selector);
        new SimpleEscrow(address(token), payer, payee, AMOUNT, address(0));
        vm.expectRevert(SimpleEscrow.ZeroAmount.selector);
        new SimpleEscrow(address(token), payer, payee, 0, admin);
    }

    // ---- fund ----

    function test_fund() public {
        vm.prank(payer);
        token.approve(address(escrow), AMOUNT);
        vm.expectEmit(address(escrow));
        emit Funded(payer, AMOUNT);
        vm.prank(payer);
        escrow.fund();
        assertTrue(escrow.funded());
        assertEq(token.balanceOf(address(escrow)), AMOUNT);
    }

    function test_fund_payerOnly() public {
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotPayer.selector, admin));
        vm.prank(admin);
        escrow.fund();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotPayer.selector, relaySigner));
        vm.prank(relaySigner);
        escrow.fund();
    }

    function test_fund_once() public {
        fund();
        vm.prank(payer);
        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(SimpleEscrow.AlreadyFunded.selector);
        vm.prank(payer);
        escrow.fund();
    }

    function test_fund_withoutAllowanceFails() public {
        vm.expectRevert(abi.encodeWithSelector(SafeToken.TokenCallFailed.selector, address(token)));
        vm.prank(payer);
        escrow.fund();
        assertFalse(escrow.funded());
    }

    function test_fund_notWhilePaused() public {
        vm.prank(admin);
        escrow.pause();
        vm.prank(payer);
        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(SimpleEscrow.IsPaused.selector);
        vm.prank(payer);
        escrow.fund();
    }

    // ---- release ----

    function test_release_byEachAllowedRole() public {
        address[3] memory callers = [payer, admin, relaySigner];
        for (uint256 i; i < callers.length; ++i) {
            setUp();
            fund();
            vm.expectEmit(address(escrow));
            emit Released(payee, AMOUNT, callers[i]);
            vm.prank(callers[i]);
            escrow.release();
            assertTrue(escrow.released());
            assertEq(token.balanceOf(payee), AMOUNT);
            assertEq(token.balanceOf(address(escrow)), 0);
        }
    }

    function test_release_rejectsOthers() public {
        fund();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAuthorized.selector, stranger));
        vm.prank(stranger);
        escrow.release();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAuthorized.selector, payee));
        vm.prank(payee);
        escrow.release();
    }

    function test_release_requiresFunding() public {
        vm.expectRevert(SimpleEscrow.NotFunded.selector);
        vm.prank(admin);
        escrow.release();
    }

    function test_release_notWhilePaused() public {
        fund();
        vm.prank(admin);
        escrow.pause();
        vm.expectRevert(SimpleEscrow.IsPaused.selector);
        vm.prank(payer);
        escrow.release();
    }

    function test_release_once() public {
        fund();
        vm.prank(admin);
        escrow.release();
        vm.expectRevert(SimpleEscrow.AlreadySettled.selector);
        vm.prank(admin);
        escrow.release();
        vm.expectRevert(SimpleEscrow.AlreadySettled.selector);
        vm.prank(admin);
        escrow.refund();
    }

    // ---- refund ----

    function test_refund() public {
        fund();
        uint256 before = token.balanceOf(payer);
        vm.expectEmit(address(escrow));
        emit Refunded(payer, AMOUNT, admin);
        vm.prank(admin);
        escrow.refund();
        assertTrue(escrow.refunded());
        assertEq(token.balanceOf(payer), before + AMOUNT);

        vm.expectRevert(SimpleEscrow.AlreadySettled.selector);
        vm.prank(admin);
        escrow.release();
        vm.expectRevert(SimpleEscrow.AlreadySettled.selector);
        vm.prank(admin);
        escrow.refund();
    }

    function test_refund_byOperatorWhilePaused() public {
        fund();
        vm.prank(admin);
        escrow.pause();
        vm.prank(relaySigner);
        escrow.refund();
        assertEq(token.balanceOf(payer), 100e18);
    }

    function test_refund_rejectsPayerAndOthers() public {
        fund();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, payer));
        vm.prank(payer);
        escrow.refund();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, stranger));
        vm.prank(stranger);
        escrow.refund();
    }

    function test_refund_requiresFunding() public {
        vm.expectRevert(SimpleEscrow.NotFunded.selector);
        vm.prank(admin);
        escrow.refund();
    }

    // ---- pause ----

    function test_pause_byAdmin() public {
        vm.expectEmit(address(escrow));
        emit Paused(admin);
        vm.prank(admin);
        escrow.pause();
        assertTrue(escrow.paused());
        assertEq(escrow.pausedBy(), admin);

        vm.expectRevert(SimpleEscrow.IsPaused.selector);
        vm.prank(admin);
        escrow.pause();

        vm.expectEmit(address(escrow));
        emit Unpaused(admin);
        vm.prank(admin);
        escrow.unpause();
        assertFalse(escrow.paused());
        assertEq(escrow.pausedBy(), address(0));

        vm.expectRevert(SimpleEscrow.NotPaused.selector);
        vm.prank(admin);
        escrow.unpause();
    }

    function test_pause_byOperator() public {
        vm.expectEmit(address(escrow));
        emit Paused(relaySigner);
        vm.prank(relaySigner);
        escrow.pause();
        assertEq(escrow.pausedBy(), relaySigner);
        vm.prank(relaySigner);
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_pause_operatorCannotLiftAdminPause() public {
        vm.prank(admin);
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAdmin.selector, relaySigner));
        vm.prank(relaySigner);
        escrow.unpause();
        assertTrue(escrow.paused());
    }

    function test_pause_adminCanLiftOperatorPause() public {
        vm.prank(relaySigner);
        escrow.pause();
        vm.prank(admin);
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_pause_rejectsOthers() public {
        address[3] memory callers = [payer, payee, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, callers[i]));
            vm.prank(callers[i]);
            escrow.pause();
        }
        vm.prank(admin);
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, payer));
        vm.prank(payer);
        escrow.unpause();
    }

    // ---- roles ----

    function test_setOperator_adminOnly() public {
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAdmin.selector, relaySigner));
        vm.prank(relaySigner);
        escrow.setOperator(stranger);

        vm.expectEmit(address(escrow));
        emit OperatorSet(relaySigner, address(0));
        vm.prank(admin);
        escrow.setOperator(address(0));
        assertEq(escrow.operator(), address(0));

        // A removed operator loses every power.
        fund();
        vm.startPrank(relaySigner);
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, relaySigner));
        escrow.pause();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, relaySigner));
        escrow.refund();
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAuthorized.selector, relaySigner));
        escrow.release();
        vm.stopPrank();
    }

    function test_removedOperatorCannotLiftItsOwnPause() public {
        vm.prank(relaySigner);
        escrow.pause();
        vm.prank(admin);
        escrow.setOperator(address(0));
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotOperatorOrAdmin.selector, relaySigner));
        vm.prank(relaySigner);
        escrow.unpause();
    }

    function test_transferAdmin() public {
        address next = makeAddr("next");
        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAdmin.selector, relaySigner));
        vm.prank(relaySigner);
        escrow.transferAdmin(relaySigner);

        vm.expectRevert(SimpleEscrow.ZeroAddress.selector);
        vm.prank(admin);
        escrow.transferAdmin(address(0));

        vm.expectEmit(address(escrow));
        emit AdminTransferred(admin, next);
        vm.prank(admin);
        escrow.transferAdmin(next);
        assertEq(escrow.admin(), next);

        vm.expectRevert(abi.encodeWithSelector(SimpleEscrow.NotAdmin.selector, admin));
        vm.prank(admin);
        escrow.setOperator(admin);
        vm.prank(next);
        escrow.setOperator(next);
    }
}
