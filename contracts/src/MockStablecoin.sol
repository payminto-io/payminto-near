// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Eip3009Stablecoin} from "./Eip3009Stablecoin.sol";

/// @notice Local-development stand-in for HashKey Chain USDC (6 decimals, EIP-2612, EIP-3009). Never deployed to a
/// live network.
contract MockStablecoin is Eip3009Stablecoin {
    constructor() Eip3009Stablecoin("USD Coin", "USDC") {}

    /// Open faucet: local chains only.
    function mint(address to, uint256 amount) external {
        require(block.chainid == 31337, "local only");
        _mint(to, amount);
    }
}
