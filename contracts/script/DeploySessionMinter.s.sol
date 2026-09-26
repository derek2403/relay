// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";

import {SessionMinter} from "../src/SessionMinter.sol";

/// Deploys the shared SessionMinter. It has no owner and no constructor arguments.
///   PRIVATE_KEY=0x... forge script script/DeploySessionMinter.s.sol --rpc-url sepolia --broadcast
contract DeploySessionMinter is Script {
    function run() external returns (SessionMinter minter) {
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        minter = new SessionMinter();
        vm.stopBroadcast();

        console.log("SessionMinter deployed at", address(minter));
        console.log("Add to .env.local: NEXT_PUBLIC_SESSION_MINTER=%s", address(minter));
    }
}
