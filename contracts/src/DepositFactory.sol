// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DepositForwarder} from "./DepositForwarder.sol";

/// @title Payminto Deposit Factory
/// @notice Deterministic per-payment deposit addresses for Payminto Gateway.
/// A forwarder is an EIP-1167 clone whose immutable args are abi.encode(terms), deployed with CREATE2 under the
/// per-payment salt, so its address commits to every split field (token, payout, fee recipient, fee, amount due):
/// nobody, including the node operator, can redirect funds sent to it or change the fee.
/// Payers send tokens to the address before it has code; anyone may later deploy it and flush in one call.
/// No owner, no admin, no upgradability.
contract DepositFactory {
    /// @notice The DepositForwarder every clone delegates to, deployed by this factory's constructor.
    address public immutable implementation;

    event ForwarderDeployed(address indexed payout, bytes32 indexed salt, address forwarder);

    error ZeroPayout();
    error ZeroAmountDue();
    error FeeExceedsAmountDue();
    error ZeroFeeRecipient();

    constructor() {
        implementation = address(new DepositForwarder());
    }

    /// @notice The forwarder address for (terms, salt), whether or not it is deployed yet. Reverts on terms that
    /// could never be flushed, so no address is ever handed out for them.
    function addressOf(DepositForwarder.Terms calldata terms, bytes32 salt) public view returns (address) {
        _validate(terms);
        return Clones.predictDeterministicAddressWithImmutableArgs(implementation, abi.encode(terms), salt);
    }

    /// @notice Deploys the forwarder if needed, then flushes its whole `token` balance. Permissionless.
    function flush(DepositForwarder.Terms calldata terms, bytes32 salt, address token)
        external
        returns (address forwarder, uint256 amount, uint256 fee)
    {
        forwarder = _deploy(terms, salt);
        (amount, fee) = DepositForwarder(payable(forwarder)).flush(token);
    }

    /// @notice Deploys the forwarder if needed, then sends its whole native balance to the payout. Permissionless.
    function flushNative(DepositForwarder.Terms calldata terms, bytes32 salt)
        external
        returns (address forwarder, uint256 amount)
    {
        forwarder = _deploy(terms, salt);
        amount = DepositForwarder(payable(forwarder)).flushNative();
    }

    function _deploy(DepositForwarder.Terms calldata terms, bytes32 salt) internal returns (address forwarder) {
        forwarder = addressOf(terms, salt);
        if (forwarder.code.length != 0) return forwarder;
        Clones.cloneDeterministicWithImmutableArgs(implementation, abi.encode(terms), salt);
        emit ForwarderDeployed(terms.payout, salt, forwarder);
    }

    function _validate(DepositForwarder.Terms calldata terms) internal pure {
        if (terms.payout == address(0)) revert ZeroPayout();
        if (terms.amountDue == 0) revert ZeroAmountDue();
        if (terms.fee > terms.amountDue) revert FeeExceedsAmountDue();
        if (terms.fee != 0 && terms.feeRecipient == address(0)) revert ZeroFeeRecipient();
    }
}
