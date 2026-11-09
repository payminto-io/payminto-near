// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Payminto Deposit Forwarder
/// @notice Keyless per-payment deposit address. Deployed only as an EIP-1167 clone with immutable args by
/// DepositFactory: the args are the payment's Terms, so the CREATE2 address commits to the payout, the fee recipient,
/// the fee and the amount due, and the forwarder can send funds nowhere else.
/// No owner, no admin, no initializer, no upgrade path: flushing is permissionless because the split is fixed.
contract DepositForwarder {
    using SafeERC20 for IERC20;

    /// @notice What a payment's deposit address is bound to. `fee` is in `token` base units and at most `amountDue`.
    struct Terms {
        address token;
        address payout;
        address feeRecipient;
        uint256 fee;
        uint256 amountDue;
    }

    /// @notice Total of `Terms.token` this forwarder has flushed so far, fee included.
    uint256 public received;
    /// @notice Fee sent to the fee recipient so far. Always min(fee, received * fee / amountDue), rounded down.
    uint256 public feePaid;

    /// The implementation's own address: it has no Terms and must never move funds.
    address private immutable _self;

    /// @notice `token` is address(0) for the native token. `amount` is the whole flush, `fee` the part of it
    /// that went to the fee recipient.
    event Flushed(address indexed token, uint256 amount, uint256 fee);

    error NotAClone();
    error NativeTransferFailed();

    constructor() {
        _self = address(this);
    }

    /// Accepts native token sent by mistake after deployment so flushNative can return it to the payout.
    receive() external payable {}

    /// @notice The Terms this clone was deployed with.
    function terms() public view returns (Terms memory) {
        if (address(this) == _self) revert NotAClone();
        return abi.decode(Clones.fetchCloneArgs(address(this)), (Terms));
    }

    /// @notice Sends the whole `token` balance out. For the payment token the fee recipient gets its pro-rata share
    /// of everything flushed so far, capped at the fee, so partial, exact and over payments split fairly and the
    /// result does not depend on how often anyone flushes. Any other token goes entirely to the payout.
    /// A zero balance is a no-op, so flushing early or twice is harmless.
    function flush(address token) external returns (uint256 amount, uint256 fee) {
        Terms memory t = terms();
        amount = IERC20(token).balanceOf(address(this));
        if (amount == 0) return (0, 0);
        if (token == t.token && t.fee != 0) {
            uint256 total = received + amount;
            uint256 owed = Math.min(t.fee, Math.mulDiv(total, t.fee, t.amountDue));
            fee = owed - feePaid;
            received = total;
            feePaid = owed;
            if (fee != 0) IERC20(token).safeTransfer(t.feeRecipient, fee);
        } else if (token == t.token) {
            received += amount;
        }
        if (amount != fee) IERC20(token).safeTransfer(t.payout, amount - fee);
        emit Flushed(token, amount, fee);
    }

    /// @notice Sends the whole native balance (HSK sent by mistake) to the payout. Fees apply only to the payment token.
    function flushNative() external returns (uint256 amount) {
        address to = terms().payout;
        amount = address(this).balance;
        if (amount == 0) return 0;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
        emit Flushed(address(0), amount, 0);
    }
}
