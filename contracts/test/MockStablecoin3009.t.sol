// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

/// EIP-3009 on the local mock, held to Circle FiatToken v2.2 behaviour so the gateway's wallet and x402 paths behave
/// the same against anvil as against USDC.e and testnet USDC.
contract MockStablecoin3009Test is Test {
    // Circle FiatToken v2 constants, copied from the deployed contracts.
    bytes32 constant CIRCLE_TRANSFER_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 constant CIRCLE_RECEIVE_TYPEHASH = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    bytes32 constant CIRCLE_CANCEL_TYPEHASH = 0x158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a1597429;

    MockStablecoin usdc;
    uint256 payerKey = 0xB0B;
    address payer;
    address merchant = makeAddr("merchant");
    address relayer = makeAddr("relayer");
    bytes32 nonce = keccak256("checkout-nonce");
    uint256 validBefore;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockStablecoin();
        payer = vm.addr(payerKey);
        usdc.mint(payer, 100e6);
        validBefore = block.timestamp + 1800;
    }

    function _digest(bytes32 typehash, address to, uint256 value, uint256 after_, uint256 before_, bytes32 n)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(typehash, payer, to, value, after_, before_, n));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(key, digest);
    }

    function _transferSig(address to, uint256 value, uint256 after_, uint256 before_, bytes32 n)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return _sign(payerKey, _digest(CIRCLE_TRANSFER_TYPEHASH, to, value, after_, before_, n));
    }

    function test_typehashesMatchCircle() public view {
        assertEq(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), CIRCLE_TRANSFER_TYPEHASH);
        assertEq(usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), CIRCLE_RECEIVE_TYPEHASH);
        assertEq(usdc.CANCEL_AUTHORIZATION_TYPEHASH(), CIRCLE_CANCEL_TYPEHASH);
    }

    function test_transferWithAuthorization() public {
        (uint8 v, bytes32 r, bytes32 s) = _transferSig(merchant, 25e6, 0, validBefore, nonce);
        assertFalse(usdc.authorizationState(payer, nonce));

        vm.expectEmit(true, true, false, false, address(usdc));
        emit AuthorizationUsed(payer, nonce);
        // A relayer submits; the payer sends no transaction and needs no native token.
        vm.prank(relayer);
        usdc.transferWithAuthorization(payer, merchant, 25e6, 0, validBefore, nonce, v, r, s);

        assertTrue(usdc.authorizationState(payer, nonce));
        assertEq(usdc.balanceOf(merchant), 25e6);
        assertEq(usdc.balanceOf(payer), 75e6);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_transferWithAuthorizationBytesSignature() public {
        (uint8 v, bytes32 r, bytes32 s) = _transferSig(merchant, 1e6, 0, validBefore, nonce);
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_revertsWhenUsed() public {
        (uint8 v, bytes32 r, bytes32 s) = _transferSig(merchant, 1e6, 0, validBefore, nonce);
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, v, r, s);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, v, r, s);
    }

    function test_revertsWhenExpired() public {
        (uint8 v, bytes32 r, bytes32 s) = _transferSig(merchant, 1e6, 0, validBefore, nonce);
        // validBefore is exclusive.
        vm.warp(validBefore);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, v, r, s);
    }

    function test_revertsWhenNotYetValid() public {
        uint256 validAfter = block.timestamp + 60;
        (uint8 v, bytes32 r, bytes32 s) = _transferSig(merchant, 1e6, validAfter, validBefore, nonce);
        vm.expectRevert("FiatTokenV2: authorization is not yet valid");
        usdc.transferWithAuthorization(payer, merchant, 1e6, validAfter, validBefore, nonce, v, r, s);
        // validAfter is exclusive too.
        vm.warp(validAfter);
        vm.expectRevert("FiatTokenV2: authorization is not yet valid");
        usdc.transferWithAuthorization(payer, merchant, 1e6, validAfter, validBefore, nonce, v, r, s);
        vm.warp(validAfter + 1);
        usdc.transferWithAuthorization(payer, merchant, 1e6, validAfter, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(merchant), 1e6);
    }

    function test_revertsOnInvalidSignature() public {
        // Signed by someone else.
        (uint8 v, bytes32 r, bytes32 s) =
            _sign(0xBAD, _digest(CIRCLE_TRANSFER_TYPEHASH, merchant, 1e6, 0, validBefore, nonce));
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, v, r, s);

        // Signed by the payer but submitted with a different amount or recipient.
        (v, r, s) = _transferSig(merchant, 1e6, 0, validBefore, nonce);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(payer, merchant, 2e6, 0, validBefore, nonce, v, r, s);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(payer, relayer, 1e6, 0, validBefore, nonce, v, r, s);

        // A receive authorization is not a transfer authorization.
        (v, r, s) = _sign(payerKey, _digest(CIRCLE_RECEIVE_TYPEHASH, merchant, 1e6, 0, validBefore, nonce));
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, v, r, s);
        assertFalse(usdc.authorizationState(payer, nonce));
    }

    function test_receiveWithAuthorization() public {
        (uint8 v, bytes32 r, bytes32 s) =
            _sign(payerKey, _digest(CIRCLE_RECEIVE_TYPEHASH, merchant, 5e6, 0, validBefore, nonce));

        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(payer, merchant, 5e6, 0, validBefore, nonce, v, r, s);

        vm.expectEmit(true, true, false, false, address(usdc));
        emit AuthorizationUsed(payer, nonce);
        vm.prank(merchant);
        usdc.receiveWithAuthorization(payer, merchant, 5e6, 0, validBefore, nonce, v, r, s);
        assertEq(usdc.balanceOf(merchant), 5e6);

        vm.prank(merchant);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.receiveWithAuthorization(payer, merchant, 5e6, 0, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function test_receiveChecksPayeeBeforeExpiry() public {
        (uint8 v, bytes32 r, bytes32 s) =
            _sign(payerKey, _digest(CIRCLE_RECEIVE_TYPEHASH, merchant, 5e6, 0, validBefore, nonce));
        vm.warp(validBefore + 1);
        vm.prank(relayer);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(payer, merchant, 5e6, 0, validBefore, nonce, v, r, s);
        vm.prank(merchant);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        usdc.receiveWithAuthorization(payer, merchant, 5e6, 0, validBefore, nonce, v, r, s);
    }

    function test_cancelAuthorization() public {
        bytes32 structHash = keccak256(abi.encode(CIRCLE_CANCEL_TYPEHASH, payer, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));

        (uint8 bv, bytes32 br, bytes32 bs) = _sign(0xBAD, digest);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.cancelAuthorization(payer, nonce, bv, br, bs);

        (uint8 v, bytes32 r, bytes32 s) = _sign(payerKey, digest);
        vm.expectEmit(true, true, false, false, address(usdc));
        emit AuthorizationCanceled(payer, nonce);
        vm.prank(relayer);
        usdc.cancelAuthorization(payer, nonce, v, r, s);
        assertTrue(usdc.authorizationState(payer, nonce));

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.cancelAuthorization(payer, nonce, abi.encodePacked(r, s, v));

        // A canceled nonce can no longer be used for a transfer.
        (v, r, s) = _transferSig(merchant, 1e6, 0, validBefore, nonce);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.transferWithAuthorization(payer, merchant, 1e6, 0, validBefore, nonce, v, r, s);
    }

    function test_revertsOnInsufficientBalance() public {
        (uint8 v, bytes32 r, bytes32 s) = _transferSig(merchant, 101e6, 0, validBefore, nonce);
        vm.expectRevert();
        usdc.transferWithAuthorization(payer, merchant, 101e6, 0, validBefore, nonce, v, r, s);
        // The revert rolls back the used marker, so the payer can still cancel or reuse the nonce.
        assertFalse(usdc.authorizationState(payer, nonce));
    }

    /// Shared vector with packages/protocol (paymentRef): keccak256(abi.encode("payminto.payment.v1", chainId, id)).
    function test_paymentRefVector() public pure {
        bytes32 ref = keccak256(abi.encode("payminto.payment.v1", uint256(177), "pay_abcdefghijklmnopqrstuvwx"));
        assertEq(ref, 0xf55b2aea1c660c824731e91908c895f215780f4d626de335933de5259f432d99);
    }
}
