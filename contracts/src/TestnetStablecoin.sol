// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Eip3009Stablecoin} from "./Eip3009Stablecoin.sol";

/// @notice Payminto Test USDC for HashKey Chain Testnet, where Circle's test USDC has no public faucet.
/// It has no value: anyone may mint up to FAUCET_LIMIT per call, and minting is refused on every other chain except
/// local anvil, so it can never pass for a real stablecoin on mainnet.
contract TestnetStablecoin is Eip3009Stablecoin {
    uint256 public constant FAUCET_LIMIT = 1_000e6;

    constructor() Eip3009Stablecoin("Payminto Test USDC", "tUSDC") {}

    /// Open faucet: HashKey Chain Testnet and local anvil only.
    function mint(address to, uint256 amount) external {
        require(block.chainid == 133 || block.chainid == 31337, "testnet only");
        require(amount <= FAUCET_LIMIT, "faucet limit");
        _mint(to, amount);
    }
}
