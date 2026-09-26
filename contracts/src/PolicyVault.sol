// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SafeToken} from "./SafeToken.sol";

/// @title PolicyVault
/// @notice The demo treasury. It holds one ERC-20 token and lets a single `agent` (the Relay signer) pay
/// approved recipients, within a per-payment maximum and a per-period limit. The owner (a human) sets the
/// recipients, limits and agent, can pause payments and can move funds directly.
///
/// These on-chain limits are the last line of defence: Relay checks its own (usually tighter) ENS grants
/// before it ever signs. A compromised Relay signer can still spend at most `periodLimit` per period, and
/// only to approved recipients.
contract PolicyVault {
    using SafeToken for address;

    address public immutable token;
    address public owner;
    address public agent;

    mapping(address => bool) public approved;

    uint256 public perTxMax;
    uint256 public periodLimit;
    uint256 public immutable periodSeconds;
    uint256 public periodStart;
    uint256 public spentInPeriod;
    bool public paused;

    event Paid(address indexed to, uint256 amount, bytes32 indexed ref, address indexed agent);
    event RecipientSet(address indexed recipient, bool approved);
    event LimitsSet(uint256 perTxMax, uint256 periodLimit);
    event AgentSet(address indexed previousAgent, address indexed newAgent);
    event OwnerTransfer(address indexed to, uint256 amount);
    event VaultPaused(address indexed by);
    event VaultUnpaused(address indexed by);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner(address caller);
    error NotAgent(address caller);
    error NotApproved(address to);
    error OverPerTx(uint256 amount, uint256 perTxMax);
    error OverPeriod(uint256 amount, uint256 remaining);
    error Paused();
    error NotPaused();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroPeriod();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    constructor(
        address token_,
        address owner_,
        address agent_,
        uint256 perTxMax_,
        uint256 periodLimit_,
        uint256 periodSeconds_
    ) {
        if (token_ == address(0) || owner_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        if (periodSeconds_ == 0) revert ZeroPeriod();
        token = token_;
        owner = owner_;
        agent = agent_;
        perTxMax = perTxMax_;
        periodLimit = periodLimit_;
        periodSeconds = periodSeconds_;
        periodStart = block.timestamp;
        emit OwnershipTransferred(address(0), owner_);
        emit AgentSet(address(0), agent_);
        emit LimitsSet(perTxMax_, periodLimit_);
    }

    // ---- agent ----

    /// @notice Pays `amount` tokens to an approved recipient. Agent only; `ref` is Relay's proposal reference.
    function pay(address to, uint256 amount, bytes32 ref) external {
        if (msg.sender != agent) revert NotAgent(msg.sender);
        if (paused) revert Paused();
        if (!approved[to]) revert NotApproved(to);
        if (amount == 0) revert ZeroAmount();
        if (amount > perTxMax) revert OverPerTx(amount, perTxMax);

        _roll();
        uint256 remaining = _remaining();
        if (amount > remaining) revert OverPeriod(amount, remaining);
        spentInPeriod += amount;

        token.safeTransfer(to, amount);
        emit Paid(to, amount, ref, msg.sender);
    }

    // ---- views ----

    /// @notice What the agent may still pay in the current period (a new period starts at full `periodLimit`).
    function remainingInPeriod() external view returns (uint256) {
        if (block.timestamp >= periodStart + periodSeconds) return periodLimit;
        return _remaining();
    }

    /// @notice When the current period ends (unix seconds). If it has already ended, the next `pay` starts a new one.
    function periodEnd() external view returns (uint256) {
        return periodStart + periodSeconds;
    }

    // ---- owner ----

    function setRecipient(address recipient, bool isApproved) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        approved[recipient] = isApproved;
        emit RecipientSet(recipient, isApproved);
    }

    function setLimits(uint256 perTxMax_, uint256 periodLimit_) external onlyOwner {
        perTxMax = perTxMax_;
        periodLimit = periodLimit_;
        emit LimitsSet(perTxMax_, periodLimit_);
    }

    /// @notice Replaces the agent. `address(0)` disables agent payments entirely.
    function setAgent(address agent_) external onlyOwner {
        emit AgentSet(agent, agent_);
        agent = agent_;
    }

    /// @notice Moves tokens out directly (not counted against the agent's limits). Used to seed demo history.
    function ownerTransfer(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
        emit OwnerTransfer(to, amount);
    }

    function pause() external onlyOwner {
        if (paused) revert Paused();
        paused = true;
        emit VaultPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit VaultUnpaused(msg.sender);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ---- internal ----

    /// Starts a new period (aligned to whole periods since `periodStart`) once the current one has ended.
    function _roll() private {
        uint256 start = periodStart;
        if (block.timestamp < start + periodSeconds) return;
        periodStart = start + ((block.timestamp - start) / periodSeconds) * periodSeconds;
        spentInPeriod = 0;
    }

    function _remaining() private view returns (uint256) {
        uint256 limit = periodLimit;
        uint256 spent = spentInPeriod;
        return spent >= limit ? 0 : limit - spent;
    }
}
