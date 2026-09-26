// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {RelayTestToken} from "../src/RelayTestToken.sol";

contract RelayTestTokenTest is Test {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    RelayTestToken token;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new RelayTestToken(owner);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Soda Test Dollar");
        assertEq(token.symbol(), "STD");
        assertEq(token.decimals(), 18);
        assertEq(token.owner(), owner);
        assertEq(token.totalSupply(), 0);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(RelayTestToken.ZeroAddress.selector);
        new RelayTestToken(address(0));
    }

    function test_mint_ownerOnly() public {
        vm.expectEmit(address(token));
        emit Transfer(address(0), alice, 5e18);
        vm.prank(owner);
        token.mint(alice, 5e18);
        assertEq(token.balanceOf(alice), 5e18);
        assertEq(token.totalSupply(), 5e18);

        vm.expectRevert(abi.encodeWithSelector(RelayTestToken.NotOwner.selector, alice));
        vm.prank(alice);
        token.mint(alice, 1);
    }

    function test_mint_rejectsZeroRecipient() public {
        vm.expectRevert(RelayTestToken.ZeroAddress.selector);
        vm.prank(owner);
        token.mint(address(0), 1);
    }

    function test_transfer() public {
        vm.prank(owner);
        token.mint(alice, 10);
        vm.expectEmit(address(token));
        emit Transfer(alice, bob, 4);
        vm.prank(alice);
        assertTrue(token.transfer(bob, 4));
        assertEq(token.balanceOf(alice), 6);
        assertEq(token.balanceOf(bob), 4);
    }

    function test_transfer_insufficientBalance() public {
        vm.prank(owner);
        token.mint(alice, 3);
        vm.expectRevert(abi.encodeWithSelector(RelayTestToken.InsufficientBalance.selector, alice, 3, 4));
        vm.prank(alice);
        token.transfer(bob, 4);
    }

    function test_transfer_rejectsZeroRecipient() public {
        vm.prank(owner);
        token.mint(alice, 3);
        vm.expectRevert(RelayTestToken.ZeroAddress.selector);
        vm.prank(alice);
        token.transfer(address(0), 1);
    }

    function test_approveAndTransferFrom() public {
        vm.prank(owner);
        token.mint(alice, 10);
        vm.expectEmit(address(token));
        emit Approval(alice, bob, 6);
        vm.prank(alice);
        token.approve(bob, 6);

        vm.prank(bob);
        token.transferFrom(alice, bob, 4);
        assertEq(token.allowance(alice, bob), 2);
        assertEq(token.balanceOf(bob), 4);

        vm.expectRevert(abi.encodeWithSelector(RelayTestToken.InsufficientAllowance.selector, bob, 2, 3));
        vm.prank(bob);
        token.transferFrom(alice, bob, 3);
    }

    function test_infiniteAllowanceIsNotDecremented() public {
        vm.prank(owner);
        token.mint(alice, 10);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        vm.prank(bob);
        token.transferFrom(alice, bob, 10);
        assertEq(token.allowance(alice, bob), type(uint256).max);
    }

    function test_transferOwnership() public {
        vm.expectRevert(abi.encodeWithSelector(RelayTestToken.NotOwner.selector, alice));
        vm.prank(alice);
        token.transferOwnership(alice);

        vm.expectRevert(RelayTestToken.ZeroAddress.selector);
        vm.prank(owner);
        token.transferOwnership(address(0));

        vm.expectEmit(address(token));
        emit OwnershipTransferred(owner, alice);
        vm.prank(owner);
        token.transferOwnership(alice);
        assertEq(token.owner(), alice);

        vm.expectRevert(abi.encodeWithSelector(RelayTestToken.NotOwner.selector, owner));
        vm.prank(owner);
        token.mint(owner, 1);
    }

    function testFuzz_transferConservesSupply(uint128 minted, uint128 sent) public {
        vm.prank(owner);
        token.mint(alice, minted);
        vm.assume(sent <= minted);
        vm.prank(alice);
        token.transfer(bob, sent);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), token.totalSupply());
    }
}
