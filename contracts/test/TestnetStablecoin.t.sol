// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {TestnetStablecoin} from "../src/TestnetStablecoin.sol";

/// Payminto Test USDC: an honest name, a capped open faucet on HashKey Chain Testnet only, and the same EIP-3009 as
/// the local mock (which MockStablecoin3009Test covers through the shared base).
contract TestnetStablecoinTest is Test {
    bytes32 constant CIRCLE_TRANSFER_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    TestnetStablecoin usdc;
    uint256 payerKey = 0xB0B;
    address payer;
    address merchant = makeAddr("merchant");

    function setUp() public {
        vm.chainId(133);
        vm.warp(1_800_000_000);
        usdc = new TestnetStablecoin();
        payer = vm.addr(payerKey);
    }

    function test_metadataSaysTestToken() public view {
        assertEq(usdc.name(), "Payminto Test USDC");
        assertEq(usdc.symbol(), "tUSDC");
        assertEq(usdc.decimals(), 6);
    }

    function test_domainIsNameAndVersionOne() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Payminto Test USDC"),
                keccak256("1"),
                uint256(133),
                address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
    }

    function test_faucetMintsUpToTheLimit() public {
        usdc.mint(payer, usdc.FAUCET_LIMIT());
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    function test_faucetRefusesMoreThanTheLimit() public {
        uint256 limit = usdc.FAUCET_LIMIT();
        vm.expectRevert("faucet limit");
        usdc.mint(payer, limit + 1);
    }

    function test_faucetRefusesOtherChains() public {
        vm.chainId(177);
        vm.expectRevert("testnet only");
        usdc.mint(payer, 1e6);
        vm.chainId(11155111);
        vm.expectRevert("testnet only");
        usdc.mint(payer, 1e6);
    }

    function test_transferWithAuthorization() public {
        usdc.mint(payer, 10e6);
        bytes32 nonce = keccak256("n1");
        uint256 validBefore = block.timestamp + 600;
        bytes32 structHash =
            keccak256(abi.encode(CIRCLE_TRANSFER_TYPEHASH, payer, merchant, 4e6, 0, validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        usdc.transferWithAuthorization(payer, merchant, 4e6, 0, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(merchant), 4e6);
        assertTrue(usdc.authorizationState(payer, nonce));
    }
}
