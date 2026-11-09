// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// EIP-3009 receive, as Circle FiatToken v2 and v2.2 expose it.
interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @title Payminto Payment Router
/// @notice Splits an EIP-3009 payment between the merchant and the platform in the transaction that moves it.
/// The payer signs a ReceiveWithAuthorization to this router whose nonce is keccak256(abi.encode(terms)), so the
/// payout and the fee are fixed by the payer's signature: nobody, including the node operator, can change them after
/// signing. The token only lets the router itself redeem a receive authorization addressed to it, so a signature
/// seen in the mempool cannot be redeemed any other way. The router holds nothing between calls.
/// No owner, no admin, no upgradability. The token's EIP-712 domain binds the signature to one token and chain.
contract PaymentRouter {
    using SafeERC20 for IERC20;

    struct PaymentTerms {
        bytes32 paymentRef;
        address payout;
        address feeRecipient;
        uint256 fee;
    }

    event PaymentRouted(
        bytes32 indexed paymentRef, address indexed from, address indexed payout, uint256 value, uint256 fee
    );

    error ZeroPayout();
    error ZeroFeeRecipient();
    error FeeExceedsValue();

    /// @notice The EIP-3009 nonce a payer signs for `t`.
    function termsNonce(PaymentTerms calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(t));
    }

    function payWithAuthorization(
        address token,
        PaymentTerms calldata t,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _check(t, value);
        IERC3009Receive(token)
            .receiveWithAuthorization(from, address(this), value, validAfter, validBefore, termsNonce(t), v, r, s);
        _split(token, t, from, value);
    }

    /// @notice Same, with a packed or ERC-1271 signature (FiatToken v2.2).
    function payWithAuthorization(
        address token,
        PaymentTerms calldata t,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata signature
    ) external {
        _check(t, value);
        IERC3009Receive(token)
            .receiveWithAuthorization(from, address(this), value, validAfter, validBefore, termsNonce(t), signature);
        _split(token, t, from, value);
    }

    function _check(PaymentTerms calldata t, uint256 value) internal pure {
        if (t.payout == address(0)) revert ZeroPayout();
        if (t.fee > value) revert FeeExceedsValue();
        if (t.fee != 0 && t.feeRecipient == address(0)) revert ZeroFeeRecipient();
    }

    function _split(address token, PaymentTerms calldata t, address from, uint256 value) internal {
        if (t.fee != 0) IERC20(token).safeTransfer(t.feeRecipient, t.fee);
        if (value != t.fee) IERC20(token).safeTransfer(t.payout, value - t.fee);
        emit PaymentRouted(t.paymentRef, from, t.payout, value, t.fee);
    }
}
