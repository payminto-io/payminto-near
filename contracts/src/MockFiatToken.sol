// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Local-development stand-in for HashKey Chain USDC.e (a Circle FiatToken): 6 decimals, EIP-2612, and a
/// blacklist under which any transfer from or to a blacklisted account reverts. Never deployed to a live network.
contract MockFiatToken is ERC20, ERC20Permit {
    mapping(address account => bool) public isBlacklisted;

    constructor() ERC20("Bridged USDC", "USDC.e") ERC20Permit("Bridged USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Open faucet: local chains only.
    function mint(address to, uint256 amount) external {
        require(block.chainid == 31337, "local only");
        _mint(to, amount);
    }

    /// Open blacklist switch: local chains only.
    function blacklist(address account) external {
        require(block.chainid == 31337, "local only");
        isBlacklisted[account] = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!isBlacklisted[from] && !isBlacklisted[to], "Blacklistable: account is blacklisted");
        super._update(from, to, value);
    }
}
