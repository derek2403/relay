// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {SafeToken} from "./SafeToken.sol";

/// @title SimpleEscrow
/// @notice The one contract template Relay agents may deploy. The payer funds `amount` tokens once; they are
/// then released to the payee or refunded to the payer. Nobody can send them anywhere else.
///
/// Roles:
/// - `admin`: the human owner (Relay enforces that it is the approving owner and never the Relay signer).
///   Full control: pause/unpause, release, refund, replace or remove the operator, hand the admin role on.
/// - `operator`: whoever deployed the escrow, i.e. the Relay signer acting on approved, ENS-granted
///   proposals. It may pause, release and refund, and unpause only a pause it made itself. It can never
///   change roles, so the admin can always cut it off with `setOperator(address(0))`.
/// - `payer`: funds the escrow and may release it.
contract SimpleEscrow {
    using SafeToken for address;

    address public immutable token;
    address public immutable payer;
    address public immutable payee;
    uint256 public immutable amount;
    address public admin;
    address public operator;

    bool public funded;
    bool public released;
    bool public refunded;
    bool public paused;
    /// Who paused the escrow (zero when not paused). An admin pause can only be lifted by the admin.
    address public pausedBy;

    event Funded(address indexed payer, uint256 amount);
    event Released(address indexed payee, uint256 amount, address indexed by);
    event Refunded(address indexed payer, uint256 amount, address indexed by);
    event Paused(address by);
    event Unpaused(address by);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event OperatorSet(address indexed previousOperator, address indexed newOperator);

    error NotPayer(address caller);
    error NotAdmin(address caller);
    error NotOperatorOrAdmin(address caller);
    error NotAuthorized(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyFunded();
    error NotFunded();
    error AlreadySettled();
    error IsPaused();
    error NotPaused();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    modifier onlyOperatorOrAdmin() {
        if (msg.sender != admin && msg.sender != operator) {
            revert NotOperatorOrAdmin(msg.sender);
        }
        _;
    }

    constructor(address token_, address payer_, address payee_, uint256 amount_, address admin_) {
        if (token_ == address(0) || payer_ == address(0) || payee_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        if (amount_ == 0) revert ZeroAmount();
        token = token_;
        payer = payer_;
        payee = payee_;
        amount = amount_;
        admin = admin_;
        operator = msg.sender;
        emit AdminTransferred(address(0), admin_);
        emit OperatorSet(address(0), msg.sender);
    }

    /// @notice Pulls `amount` from the payer (who must have approved this contract first). Payer only, once.
    function fund() external {
        if (msg.sender != payer) revert NotPayer(msg.sender);
        if (funded) revert AlreadyFunded();
        if (paused) revert IsPaused();
        funded = true;
        token.safeTransferFrom(payer, address(this), amount);
        emit Funded(payer, amount);
    }

    /// @notice Sends the escrowed amount to the payee. Payer, admin or operator, while funded, unsettled and
    /// not paused.
    function release() external {
        if (msg.sender != payer && msg.sender != admin && msg.sender != operator) {
            revert NotAuthorized(msg.sender);
        }
        if (paused) revert IsPaused();
        if (!funded) revert NotFunded();
        if (released || refunded) revert AlreadySettled();
        released = true;
        token.safeTransfer(payee, amount);
        emit Released(payee, amount, msg.sender);
    }

    /// @notice Returns the escrowed amount to the payer. Admin or operator (allowed while paused), once, if
    /// unsettled.
    function refund() external onlyOperatorOrAdmin {
        if (!funded) revert NotFunded();
        if (released || refunded) revert AlreadySettled();
        refunded = true;
        token.safeTransfer(payer, amount);
        emit Refunded(payer, amount, msg.sender);
    }

    function pause() external onlyOperatorOrAdmin {
        if (paused) revert IsPaused();
        paused = true;
        pausedBy = msg.sender;
        emit Paused(msg.sender);
    }

    /// @notice Lifts a pause. The admin can lift any pause; the operator only one it made itself.
    function unpause() external onlyOperatorOrAdmin {
        if (!paused) revert NotPaused();
        if (msg.sender != admin && pausedBy != msg.sender) revert NotAdmin(msg.sender);
        paused = false;
        pausedBy = address(0);
        emit Unpaused(msg.sender);
    }

    /// @notice Replaces the operator; `address(0)` removes it. Admin only.
    function setOperator(address newOperator) external onlyAdmin {
        emit OperatorSet(operator, newOperator);
        operator = newOperator;
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }
}
