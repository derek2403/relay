// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Minimal checked ERC-20 calls: the call must succeed, the target must be a contract, and a
/// returned value (if any) must be `true`.
library SafeToken {
    error TokenCallFailed(address token);

    function safeTransfer(address token, address to, uint256 value) internal {
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, value)); // transfer(address,uint256)
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        _call(token, abi.encodeWithSelector(0x23b872dd, from, to, value)); // transferFrom(address,address,uint256)
    }

    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TokenCallFailed(token);
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) {
            revert TokenCallFailed(token);
        }
    }
}
