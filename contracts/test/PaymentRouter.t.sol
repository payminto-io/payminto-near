// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

/// EIP-3009 payments split between merchant and platform, with terms fixed by the payer's signature.
contract PaymentRouterTest is Test {
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    PaymentRouter router;
    MockStablecoin usdc;
    uint256 payerKey = 0xB0B;
    address payer;
    address merchant = makeAddr("merchant");
    address platform = makeAddr("platform");
    address relayer = makeAddr("relayer");
    address attacker = makeAddr("attacker");
    uint256 validBefore;

    event PaymentRouted(
        bytes32 indexed paymentRef, address indexed from, address indexed payout, uint256 value, uint256 fee
    );

    function setUp() public {
        vm.warp(1_800_000_000);
        router = new PaymentRouter();
        usdc = new MockStablecoin();
        payer = vm.addr(payerKey);
        usdc.mint(payer, 1_000e6);
        validBefore = block.timestamp + 1800;
    }

    function _terms(uint256 fee) internal view returns (PaymentRouter.PaymentTerms memory) {
        return PaymentRouter.PaymentTerms({
            paymentRef: keccak256("pay_1"), payout: merchant, feeRecipient: platform, fee: fee
        });
    }

    function _sign(PaymentRouter.PaymentTerms memory t, uint256 value)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(RECEIVE_TYPEHASH, payer, address(router), value, 0, validBefore, keccak256(abi.encode(t)))
        );
        (v, r, s) = vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_routesWithFee() public {
        PaymentRouter.PaymentTerms memory t = _terms(0.5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 100e6);

        vm.expectEmit(true, true, true, true, address(router));
        emit PaymentRouted(t.paymentRef, payer, merchant, 100e6, 0.5e6);
        vm.prank(relayer);
        router.payWithAuthorization(address(usdc), t, payer, 100e6, 0, validBefore, v, r, s);

        assertEq(usdc.balanceOf(merchant), 99.5e6);
        assertEq(usdc.balanceOf(platform), 0.5e6);
        assertEq(usdc.balanceOf(payer), 900e6);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(relayer), 0);
        assertTrue(usdc.authorizationState(payer, router.termsNonce(t)));
        assertEq(router.termsNonce(t), keccak256(abi.encode(t)));
    }

    function test_routesWithBytesSignature() public {
        PaymentRouter.PaymentTerms memory t = _terms(1e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 10e6);
        router.payWithAuthorization(address(usdc), t, payer, 10e6, 0, validBefore, abi.encodePacked(r, s, v));
        assertEq(usdc.balanceOf(merchant), 9e6);
        assertEq(usdc.balanceOf(platform), 1e6);
    }

    function test_zeroFee() public {
        PaymentRouter.PaymentTerms memory t = _terms(0);
        t.feeRecipient = address(0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 25e6);
        router.payWithAuthorization(address(usdc), t, payer, 25e6, 0, validBefore, v, r, s);
        assertEq(usdc.balanceOf(merchant), 25e6);
        assertEq(usdc.balanceOf(address(router)), 0);
    }

    function test_feeEqualToValue() public {
        PaymentRouter.PaymentTerms memory t = _terms(5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 5e6);
        router.payWithAuthorization(address(usdc), t, payer, 5e6, 0, validBefore, v, r, s);
        assertEq(usdc.balanceOf(platform), 5e6);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    function test_tamperedTermsFailTheSignature() public {
        PaymentRouter.PaymentTerms memory t = _terms(0.5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 100e6);

        PaymentRouter.PaymentTerms memory changed = _terms(0.5e6);
        changed.payout = attacker;
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(address(usdc), changed, payer, 100e6, 0, validBefore, v, r, s);

        changed = _terms(5e6);
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(address(usdc), changed, payer, 100e6, 0, validBefore, v, r, s);

        changed = _terms(0.5e6);
        changed.feeRecipient = attacker;
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(address(usdc), changed, payer, 100e6, 0, validBefore, v, r, s);

        changed = _terms(0.5e6);
        changed.paymentRef = keccak256("pay_2");
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(address(usdc), changed, payer, 100e6, 0, validBefore, v, r, s);

        // A different value is not what the payer signed either.
        vm.expectRevert("FiatTokenV2: invalid signature");
        router.payWithAuthorization(address(usdc), t, payer, 90e6, 0, validBefore, v, r, s);
        assertEq(usdc.balanceOf(payer), 1_000e6);
    }

    function test_signatureCannotBeRedeemedOutsideTheRouter() public {
        PaymentRouter.PaymentTerms memory t = _terms(0.5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 100e6);
        vm.prank(attacker);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(payer, address(router), 100e6, 0, validBefore, keccak256(abi.encode(t)), v, r, s);
    }

    function test_rejectsFeeAboveValue() public {
        PaymentRouter.PaymentTerms memory t = _terms(101e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 100e6);
        vm.expectRevert(PaymentRouter.FeeExceedsValue.selector);
        router.payWithAuthorization(address(usdc), t, payer, 100e6, 0, validBefore, v, r, s);
    }

    function test_rejectsMissingRecipients() public {
        PaymentRouter.PaymentTerms memory t = _terms(1e6);
        t.feeRecipient = address(0);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 10e6);
        vm.expectRevert(PaymentRouter.ZeroFeeRecipient.selector);
        router.payWithAuthorization(address(usdc), t, payer, 10e6, 0, validBefore, v, r, s);

        t = _terms(1e6);
        t.payout = address(0);
        (v, r, s) = _sign(t, 10e6);
        vm.expectRevert(PaymentRouter.ZeroPayout.selector);
        router.payWithAuthorization(address(usdc), t, payer, 10e6, 0, validBefore, v, r, s);
    }

    function test_replayReverts() public {
        PaymentRouter.PaymentTerms memory t = _terms(0.5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 100e6);
        router.payWithAuthorization(address(usdc), t, payer, 100e6, 0, validBefore, v, r, s);
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        router.payWithAuthorization(address(usdc), t, payer, 100e6, 0, validBefore, v, r, s);
        assertEq(usdc.balanceOf(merchant), 99.5e6);
    }

    function test_expiredAuthorizationReverts() public {
        PaymentRouter.PaymentTerms memory t = _terms(0.5e6);
        (uint8 v, bytes32 r, bytes32 s) = _sign(t, 100e6);
        vm.warp(validBefore);
        vm.expectRevert("FiatTokenV2: authorization is expired");
        router.payWithAuthorization(address(usdc), t, payer, 100e6, 0, validBefore, v, r, s);
    }

    /// Shared vector with packages/protocol (paymentTermsNonce).
    function test_termsNonceVector() public view {
        PaymentRouter.PaymentTerms memory t = PaymentRouter.PaymentTerms({
            paymentRef: bytes32(uint256(1)),
            payout: address(0x1111111111111111111111111111111111111111),
            feeRecipient: address(0x2222222222222222222222222222222222222222),
            fee: 500_000
        });
        assertEq(router.termsNonce(t), 0x071f2bfc6c4465dc7f2a03d0fa4cfe0b22de949b101bc721ad07d2c1093f98f7);
    }
}
