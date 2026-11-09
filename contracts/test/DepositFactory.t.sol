// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {DepositFactory} from "../src/DepositFactory.sol";
import {DepositForwarder} from "../src/DepositForwarder.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

/// Per-payment deposit addresses: predictable before deployment, bound to one payout and fee split, flushable by anyone.
contract DepositFactoryTest is Test {
    DepositFactory factory;
    MockStablecoin usdc;
    MockStablecoin other;

    address merchant = makeAddr("merchant");
    address platform = makeAddr("platform");
    address attacker = makeAddr("attacker");
    address payer = makeAddr("payer");
    bytes32 salt = keccak256("payment-1");

    event ForwarderDeployed(address indexed payout, bytes32 indexed salt, address forwarder);
    event Flushed(address indexed token, uint256 amount, uint256 fee);

    function setUp() public {
        factory = new DepositFactory();
        usdc = new MockStablecoin();
        other = new MockStablecoin();
        usdc.mint(payer, 1_000_000e6);
        other.mint(payer, 1_000e6);
    }

    /// 100.00 due with a 0.50 fee.
    function _terms() internal view returns (DepositForwarder.Terms memory) {
        return DepositForwarder.Terms({
            token: address(usdc), payout: merchant, feeRecipient: platform, fee: 0.5e6, amountDue: 100e6
        });
    }

    function _pay(address to, uint256 amount) internal {
        vm.prank(payer);
        assertTrue(usdc.transfer(to, amount));
    }

    function test_addressOfMatchesDeployment() public {
        DepositForwarder.Terms memory t = _terms();
        address predicted = factory.addressOf(t, salt);
        assertEq(predicted.code.length, 0);
        assertEq(
            predicted,
            Clones.predictDeterministicAddressWithImmutableArgs(
                factory.implementation(), abi.encode(t), salt, address(factory)
            )
        );

        vm.expectEmit(true, true, false, true, address(factory));
        emit ForwarderDeployed(merchant, salt, predicted);
        (address forwarder,,) = factory.flush(t, salt, address(usdc));

        assertEq(forwarder, predicted);
        DepositForwarder.Terms memory stored = DepositForwarder(payable(forwarder)).terms();
        assertEq(abi.encode(stored), abi.encode(t));
    }

    function test_exactPaymentSplits() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        _pay(deposit, 100e6);

        vm.expectEmit(true, false, false, true, deposit);
        emit Flushed(address(usdc), 100e6, 0.5e6);
        // Anyone may flush; the caller gets nothing.
        vm.prank(attacker);
        (address forwarder, uint256 amount, uint256 fee) = factory.flush(t, salt, address(usdc));

        assertEq(forwarder, deposit);
        assertEq(amount, 100e6);
        assertEq(fee, 0.5e6);
        assertEq(usdc.balanceOf(merchant), 99.5e6);
        assertEq(usdc.balanceOf(platform), 0.5e6);
        assertEq(usdc.balanceOf(deposit), 0);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(factory)), 0);
    }

    function test_partialPaymentSplitsProRata() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        _pay(deposit, 40e6);
        (,, uint256 fee) = factory.flush(t, salt, address(usdc));
        assertEq(fee, 0.2e6);
        assertEq(usdc.balanceOf(merchant), 39.8e6);

        // The rest arrives later: the fee recipient ends with exactly the fee.
        _pay(deposit, 60e6);
        (,, fee) = factory.flush(t, salt, address(usdc));
        assertEq(fee, 0.3e6);
        assertEq(usdc.balanceOf(platform), 0.5e6);
        assertEq(usdc.balanceOf(merchant), 99.5e6);
    }

    function test_overPaymentCapsFeeAtTerms() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        _pay(deposit, 150e6);
        (,, uint256 fee) = factory.flush(t, salt, address(usdc));
        assertEq(fee, 0.5e6);
        assertEq(usdc.balanceOf(merchant), 149.5e6);

        // A late top-up after the cap owes no further fee.
        _pay(deposit, 10e6);
        (,, fee) = factory.flush(t, salt, address(usdc));
        assertEq(fee, 0);
        assertEq(usdc.balanceOf(platform), 0.5e6);
        assertEq(usdc.balanceOf(merchant), 159.5e6);
    }

    function test_zeroFeePaysEverythingToPayout() public {
        DepositForwarder.Terms memory t = _terms();
        t.fee = 0;
        t.feeRecipient = address(0);
        address deposit = factory.addressOf(t, salt);
        _pay(deposit, 100e6);
        (,, uint256 fee) = factory.flush(t, salt, address(usdc));
        assertEq(fee, 0);
        assertEq(usdc.balanceOf(merchant), 100e6);
        assertEq(DepositForwarder(payable(deposit)).received(), 100e6);
    }

    function test_feeEqualToAmountDue() public {
        DepositForwarder.Terms memory t = _terms();
        t.fee = t.amountDue;
        address deposit = factory.addressOf(t, salt);
        _pay(deposit, 100e6);
        factory.flush(t, salt, address(usdc));
        assertEq(usdc.balanceOf(platform), 100e6);
        assertEq(usdc.balanceOf(merchant), 0);
    }

    /// However the deposits are chunked and flushed, the fee is min(fee, floor(total * fee / amountDue)).
    function testFuzz_roundingNeverExceedsFee(uint64 fee, uint64 amountDue, uint64[4] memory chunks) public {
        amountDue = uint64(bound(amountDue, 1, 1e15));
        fee = uint64(bound(fee, 0, amountDue));
        DepositForwarder.Terms memory t = _terms();
        t.fee = fee;
        t.amountDue = amountDue;
        address deposit = factory.addressOf(t, salt);
        uint256 total;
        for (uint256 i = 0; i < chunks.length; i++) {
            uint256 c = bound(chunks[i], 0, 200_000e6);
            total += c;
            _pay(deposit, c);
            factory.flush(t, salt, address(usdc));
            uint256 paid = usdc.balanceOf(platform);
            assertLe(paid, fee);
            assertEq(paid, total * fee / amountDue < fee ? total * fee / amountDue : fee);
            assertEq(paid + usdc.balanceOf(merchant), total);
        }
        assertEq(usdc.balanceOf(deposit), 0);
    }

    function test_doubleFlush() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        _pay(deposit, 100e6);
        factory.flush(t, salt, address(usdc));

        // Second flush with nothing new: no revert, no second deployment event, nothing moves.
        vm.recordLogs();
        (, uint256 again, uint256 fee) = factory.flush(t, salt, address(usdc));
        assertEq(again, 0);
        assertEq(fee, 0);
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_flushBeforeAnyDeposit() public {
        DepositForwarder.Terms memory t = _terms();
        (address forwarder, uint256 amount,) = factory.flush(t, salt, address(usdc));
        assertEq(amount, 0);
        assertGt(forwarder.code.length, 0);

        _pay(forwarder, 100e6);
        // The forwarder itself is also flushable directly once deployed.
        (uint256 direct, uint256 fee) = DepositForwarder(payable(forwarder)).flush(address(usdc));
        assertEq(direct, 100e6);
        assertEq(fee, 0.5e6);
        assertEq(usdc.balanceOf(merchant), 99.5e6);
    }

    function test_otherTokenGoesToPayoutWithoutFee() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        vm.prank(payer);
        assertTrue(other.transfer(deposit, 5e6));
        (,, uint256 fee) = factory.flush(t, salt, address(other));
        assertEq(fee, 0);
        assertEq(other.balanceOf(merchant), 5e6);
        assertEq(DepositForwarder(payable(deposit)).received(), 0);
    }

    function test_noOtherDeployerCanClaimTheAddress() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        address impl = factory.implementation();

        // A clone of the same implementation with the same args deployed by anyone else lands elsewhere.
        address rogue = Clones.cloneDeterministicWithImmutableArgs(impl, abi.encode(t), salt);
        assertTrue(rogue != deposit);

        // Flushing through the factory, by anyone, always deploys the clone with the bound terms.
        _pay(deposit, 100e6);
        vm.prank(attacker);
        factory.flush(t, salt, address(usdc));
        assertEq(DepositForwarder(payable(deposit)).terms().payout, merchant);
        assertEq(usdc.balanceOf(merchant), 99.5e6);
    }

    function test_implementationCannotBeFlushed() public {
        DepositForwarder impl = DepositForwarder(payable(factory.implementation()));
        vm.expectRevert(DepositForwarder.NotAClone.selector);
        impl.flush(address(usdc));
        vm.expectRevert(DepositForwarder.NotAClone.selector);
        impl.flushNative();
        vm.expectRevert(DepositForwarder.NotAClone.selector);
        impl.terms();
    }

    function test_rejectsUnflushableTerms() public {
        DepositForwarder.Terms memory t = _terms();
        t.payout = address(0);
        vm.expectRevert(DepositFactory.ZeroPayout.selector);
        factory.addressOf(t, salt);

        t = _terms();
        t.amountDue = 0;
        vm.expectRevert(DepositFactory.ZeroAmountDue.selector);
        factory.addressOf(t, salt);
        vm.expectRevert(DepositFactory.ZeroAmountDue.selector);
        factory.flush(t, salt, address(usdc));

        t = _terms();
        t.fee = t.amountDue + 1;
        vm.expectRevert(DepositFactory.FeeExceedsAmountDue.selector);
        factory.addressOf(t, salt);

        t = _terms();
        t.feeRecipient = address(0);
        vm.expectRevert(DepositFactory.ZeroFeeRecipient.selector);
        factory.addressOf(t, salt);
    }

    function test_addressBindsEverySplitField() public {
        DepositForwarder.Terms memory base = _terms();
        address a = factory.addressOf(base, salt);
        DepositForwarder.Terms memory t;

        t = _terms();
        t.token = address(other);
        assertTrue(factory.addressOf(t, salt) != a);
        t = _terms();
        t.payout = attacker;
        assertTrue(factory.addressOf(t, salt) != a);
        t = _terms();
        t.feeRecipient = attacker;
        assertTrue(factory.addressOf(t, salt) != a);
        t = _terms();
        t.fee = base.fee + 1;
        assertTrue(factory.addressOf(t, salt) != a);
        t = _terms();
        t.amountDue = base.amountDue + 1;
        assertTrue(factory.addressOf(t, salt) != a);
        assertTrue(factory.addressOf(base, keccak256("payment-2")) != a);

        // Funds sent to the merchant's address cannot be pulled through a forwarder with other terms.
        _pay(a, 100e6);
        t = _terms();
        t.feeRecipient = attacker;
        t.fee = t.amountDue;
        (, uint256 amount,) = factory.flush(t, salt, address(usdc));
        assertEq(amount, 0);
        assertEq(usdc.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(a), 100e6);
    }

    function testFuzz_addressBoundToPayout(address p1, address p2) public view {
        vm.assume(p1 != p2 && p1 != address(0) && p2 != address(0));
        DepositForwarder.Terms memory t1 = _terms();
        DepositForwarder.Terms memory t2 = _terms();
        t1.payout = p1;
        t2.payout = p2;
        assertTrue(factory.addressOf(t1, salt) != factory.addressOf(t2, salt));
    }

    function test_flushNative() public {
        DepositForwarder.Terms memory t = _terms();
        address deposit = factory.addressOf(t, salt);
        // HSK sent before deployment (no code yet) and after deployment (receive()) both reach the payout, fee free.
        vm.deal(deposit, 1 ether);
        vm.expectEmit(true, false, false, true, deposit);
        emit Flushed(address(0), 1 ether, 0);
        vm.prank(attacker);
        (address forwarder, uint256 amount) = factory.flushNative(t, salt);
        assertEq(forwarder, deposit);
        assertEq(amount, 1 ether);
        assertEq(merchant.balance, 1 ether);

        vm.deal(payer, 2 ether);
        vm.prank(payer);
        (bool ok,) = deposit.call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(DepositForwarder(payable(deposit)).flushNative(), 2 ether);
        assertEq(merchant.balance, 3 ether);
        assertEq(platform.balance, 0);
        assertEq(DepositForwarder(payable(deposit)).flushNative(), 0);
    }

    function test_flushNativeRevertsWhenPayoutRejects() public {
        DepositForwarder.Terms memory t = _terms();
        t.payout = address(new Rejecter());
        address deposit = factory.addressOf(t, salt);
        vm.deal(deposit, 1 ether);
        vm.expectRevert(DepositForwarder.NativeTransferFailed.selector);
        factory.flushNative(t, salt);
        assertEq(deposit.balance, 1 ether);
    }

    /// Shared vector with packages/protocol (depositSalt): keccak256(abi.encode("payminto.deposit.v1", chainId, id)).
    function test_depositSaltVector() public pure {
        bytes32 s = keccak256(abi.encode("payminto.deposit.v1", uint256(31337), "pay_abcdefghijklmnopqrstuvwx"));
        assertEq(s, 0x646eeebbfb022ec366fb008fe076baa5f9ac01b6d01cc0a557e37e5e67a658a3);
    }
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}
