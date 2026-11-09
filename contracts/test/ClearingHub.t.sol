// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ClearingHub} from "../src/ClearingHub.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Minimal ERC-1271 wallet that accepts signatures from a single EOA signer, standing in for a Safe.
contract MockSmartWallet is IERC1271 {
    address public immutable signer;

    constructor(address s) {
        signer = s;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (uint8 v, bytes32 r, bytes32 s) = (uint8(sig[64]), bytes32(sig[0:32]), bytes32(sig[32:64]));
        return ecrecover(hash, v, r, s) == signer ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract ClearingHubTest is Test {
    using SafeCast for uint256;

    ClearingHub hub;
    MockUSDC usdc;

    uint256 ownerKey = 0xA11CE;
    uint256 agentAKey = 0xA6E17A;
    uint256 agentBKey = 0xA6E17B;
    address owner;
    address agentA;
    address agentB;
    address providerX = makeAddr("providerX");
    address providerY = makeAddr("providerY");

    function setUp() public {
        vm.warp(1_800_000_000);
        hub = new ClearingHub();
        usdc = new MockUSDC();
        owner = vm.addr(ownerKey);
        agentA = vm.addr(agentAKey);
        agentB = vm.addr(agentBKey);
        for (uint256 i; i < 2; ++i) {
            address a = i == 0 ? agentA : agentB;
            usdc.mint(a, 1_000e6);
            vm.prank(a);
            usdc.approve(address(hub), type(uint256).max);
        }
    }

    // ------------------------------------------------------------------ helpers

    function _mandate(address agent, uint256 cap, bytes32 payeesRoot)
        internal
        view
        returns (ClearingHub.Mandate memory)
    {
        return ClearingHub.Mandate({
            owner: owner,
            agent: agent,
            token: address(usdc),
            totalCap: cap,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + 1 days),
            payeesRoot: payeesRoot,
            policyHash: keccak256("perCall=0.05;daily=20"),
            salt: keccak256(abi.encode(agent, cap))
        });
    }

    function _open(ClearingHub.Mandate memory m) internal returns (bytes32 id) {
        id = hub.mandateDigest(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, id);
        id = hub.openMandate(m, abi.encodePacked(r, s, v));
    }

    function _claim(uint256 agentKey, bytes32 mandateId, address payee, uint256 cumulative)
        internal
        view
        returns (ClearingHub.Claim memory c)
    {
        c.voucher = ClearingHub.Voucher({mandateId: mandateId, payee: payee, cumulative: cumulative});
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, hub.voucherDigest(c.voucher));
        c.agentSig = abi.encodePacked(r, s, v);
    }

    function _settle(bytes32 batchId, ClearingHub.Claim[] memory claims) internal returns (uint256) {
        return hub.settleBatch(batchId, keccak256(abi.encode(batchId)), address(usdc), claims);
    }

    function _one(ClearingHub.Claim memory c) internal pure returns (ClearingHub.Claim[] memory arr) {
        arr = new ClearingHub.Claim[](1);
        arr[0] = c;
    }

    // ------------------------------------------------------------------ mandates

    function test_openMandate_recordsState() public {
        ClearingHub.Mandate memory m = _mandate(agentA, 100e6, bytes32(0));
        bytes32 id = _open(m);
        (address o, address a, address t,,,, uint256 cap,,) = hub.mandates(id);
        assertEq(o, owner);
        assertEq(a, agentA);
        assertEq(t, address(usdc));
        assertEq(cap, 100e6);
    }

    function test_openMandate_rejectsForgedOwner() public {
        ClearingHub.Mandate memory m = _mandate(agentA, 100e6, bytes32(0));
        bytes32 digest = hub.mandateDigest(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentAKey, digest);
        vm.expectRevert(ClearingHub.BadOwnerSignature.selector);
        hub.openMandate(m, abi.encodePacked(r, s, v));
    }

    function test_openMandate_rejectsDuplicateAndExpired() public {
        ClearingHub.Mandate memory m = _mandate(agentA, 100e6, bytes32(0));
        _open(m);
        bytes32 digest = hub.mandateDigest(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        vm.expectRevert(ClearingHub.MandateExists.selector);
        hub.openMandate(m, abi.encodePacked(r, s, v));

        ClearingHub.Mandate memory old = _mandate(agentB, 1, bytes32(0));
        old.validUntil = uint64(block.timestamp);
        vm.expectRevert(ClearingHub.InvalidMandate.selector);
        hub.openMandate(old, "");
    }

    function test_openMandate_rejectsUnsettleableExpiry() public {
        ClearingHub.Mandate memory m = _mandate(agentA, 100e6, bytes32(0));
        m.validUntil = type(uint64).max;
        vm.expectRevert(ClearingHub.InvalidMandate.selector);
        hub.openMandate(m, "");
    }

    function test_openMandate_supportsSmartWalletOwner() public {
        MockSmartWallet safe = new MockSmartWallet(owner);
        ClearingHub.Mandate memory m = _mandate(agentA, 100e6, bytes32(0));
        m.owner = address(safe);
        bytes32 digest = hub.mandateDigest(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        bytes32 id = hub.openMandate(m, abi.encodePacked(r, s, v));
        (address o,,,,,,,,) = hub.mandates(id);
        assertEq(o, address(safe));
    }

    // ------------------------------------------------------------------ settlement

    function test_settle_singleVoucherPaysProvider() public {
        bytes32 id = _open(_mandate(agentA, 100e6, bytes32(0)));
        uint256 transfers = _settle("b1", _one(_claim(agentAKey, id, providerX, 3_250_000)));
        assertEq(transfers, 1);
        assertEq(usdc.balanceOf(providerX), 3_250_000);
        assertEq(usdc.balanceOf(agentA), 1_000e6 - 3_250_000);
        assertEq(hub.settled(id, providerX), 3_250_000);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }

    function test_settle_isIncrementalOnCumulativeVouchers() public {
        bytes32 id = _open(_mandate(agentA, 100e6, bytes32(0)));
        _settle("b1", _one(_claim(agentAKey, id, providerX, 2e6)));
        _settle("b2", _one(_claim(agentAKey, id, providerX, 5e6)));
        assertEq(usdc.balanceOf(providerX), 5e6);

        ClearingHub.Claim[] memory stale = _one(_claim(agentAKey, id, providerX, 4e6));
        vm.expectRevert(ClearingHub.StaleVoucher.selector);
        _settle("b3", stale);
    }

    function test_settle_replayOfSameVoucherReverts() public {
        bytes32 id = _open(_mandate(agentA, 100e6, bytes32(0)));
        ClearingHub.Claim memory c = _claim(agentAKey, id, providerX, 2e6);
        _settle("b1", _one(c));
        ClearingHub.Claim[] memory replay = _one(c);
        vm.expectRevert(ClearingHub.NothingToSettle.selector);
        _settle("b2", replay);
        assertEq(usdc.balanceOf(providerX), 2e6);
        (,,, uint64 settledAt,,) = hub.batches("b2");
        assertEq(settledAt, 0, "a reverted replay stores no batch");
    }

    /// A batch of already-settled vouchers would otherwise let anyone anchor a receipts root of made-up calls.
    function test_settle_zeroDeltaBatchCannotAnchorFakeReceiptsRoot() public {
        bytes32 id = _open(_mandate(agentA, 100e6, bytes32(0)));
        ClearingHub.Claim memory c = _claim(agentAKey, id, providerX, 2e6);
        _settle("real", _one(c));

        bytes32 fakeLeaf = keccak256("made-up receipt");
        ClearingHub.Claim[] memory replay = _one(c);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(ClearingHub.NothingToSettle.selector);
        hub.settleBatch("fake", fakeLeaf, address(usdc), replay);
        assertFalse(hub.verifyReceipt("fake", fakeLeaf, new bytes32[](0)));
    }

    function test_settle_recordsSettler() public {
        bytes32 id = _open(_mandate(agentA, 100e6, bytes32(0)));
        address operator = makeAddr("operator");
        ClearingHub.Claim[] memory claims = _one(_claim(agentAKey, id, providerX, 1e6));
        vm.prank(operator);
        hub.settleBatch("op", keccak256("root"), address(usdc), claims);
        (bytes32 root,, address settler,,,) = hub.batches("op");
        assertEq(settler, operator);
        assertEq(root, keccak256("root"));
    }

    function test_settle_netsBilateralObligations() public {
        // Agent A buys 7 USDC of work from agent B; agent B buys 4 USDC of work from agent A.
        bytes32 idA = _open(_mandate(agentA, 100e6, bytes32(0)));
        bytes32 idB = _open(_mandate(agentB, 100e6, bytes32(0)));
        ClearingHub.Claim[] memory claims = new ClearingHub.Claim[](2);
        claims[0] = _claim(agentAKey, idA, agentB, 7e6);
        claims[1] = _claim(agentBKey, idB, agentA, 4e6);

        vm.recordLogs();
        uint256 transfers = _settle("net", claims);
        assertEq(transfers, 1, "11 USDC gross clears with one 3 USDC transfer");
        assertEq(usdc.balanceOf(agentA), 1_000e6 - 3e6);
        assertEq(usdc.balanceOf(agentB), 1_000e6 + 3e6);
        (,,,, uint128 gross, uint128 net) = hub.batches("net");
        assertEq(gross, 11e6);
        assertEq(net, 3e6);
    }

    function test_settle_multilateralNetting() public {
        // A pays X and Y, B pays X; X also sells nothing back. Three payees collapse into net flows.
        bytes32 idA = _open(_mandate(agentA, 100e6, bytes32(0)));
        bytes32 idB = _open(_mandate(agentB, 100e6, bytes32(0)));
        ClearingHub.Claim[] memory claims = new ClearingHub.Claim[](4);
        claims[0] = _claim(agentAKey, idA, providerX, 2e6);
        claims[1] = _claim(agentAKey, idA, providerY, 1e6);
        claims[2] = _claim(agentBKey, idB, providerX, 5e6);
        claims[3] = _claim(agentAKey, idA, agentB, 6e6); // A buys from B
        uint256 transfers = _settle("multi", claims);
        // Net: A -9, B +1, X +7, Y +1 -> three transfers from A instead of four gross ones.
        assertEq(transfers, 3);
        assertEq(usdc.balanceOf(agentA), 1_000e6 - 9e6);
        assertEq(usdc.balanceOf(agentB), 1_000e6 + 1e6);
        assertEq(usdc.balanceOf(providerX), 7e6);
        assertEq(usdc.balanceOf(providerY), 1e6);
    }

    function test_settle_enforcesTotalCap() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        ClearingHub.Claim[] memory claims = new ClearingHub.Claim[](2);
        claims[0] = _claim(agentAKey, id, providerX, 6e6);
        claims[1] = _claim(agentAKey, id, providerY, 5e6);
        vm.expectRevert(ClearingHub.CapExceeded.selector);
        _settle("cap", claims);
    }

    function test_settle_rejectsForgedVoucher() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        ClearingHub.Claim[] memory forged = _one(_claim(agentBKey, id, providerX, 1e6));
        vm.expectRevert(ClearingHub.BadAgentSignature.selector);
        _settle("forged", forged);
    }

    function test_settle_enforcesPayeeAllowlist() public {
        // Two-leaf StandardMerkleTree over [address]: leaves are double-hashed, pairs sorted.
        bytes32 lx = keccak256(bytes.concat(keccak256(abi.encode(providerX))));
        bytes32 ly = keccak256(bytes.concat(keccak256(abi.encode(providerY))));
        bytes32 root = lx < ly ? keccak256(abi.encode(lx, ly)) : keccak256(abi.encode(ly, lx));
        bytes32 id = _open(_mandate(agentA, 10e6, root));

        ClearingHub.Claim memory ok = _claim(agentAKey, id, providerX, 1e6);
        ok.payeeProof = new bytes32[](1);
        ok.payeeProof[0] = ly;
        _settle("allowed", _one(ok));
        assertEq(usdc.balanceOf(providerX), 1e6);

        ClearingHub.Claim memory bad = _claim(agentAKey, id, makeAddr("attacker"), 1e6);
        bad.payeeProof = ok.payeeProof;
        vm.expectRevert(ClearingHub.PayeeNotAllowed.selector);
        _settle("blocked", _one(bad));
    }

    function test_revoke_allowsGraceThenBlocks() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        vm.prank(owner);
        hub.revokeMandate(id);

        vm.warp(block.timestamp + 30 minutes);
        _settle("inGrace", _one(_claim(agentAKey, id, providerX, 1e6)));

        vm.warp(block.timestamp + 31 minutes);
        ClearingHub.Claim[] memory late = _one(_claim(agentAKey, id, providerX, 2e6));
        vm.expectRevert(ClearingHub.MandateNotActive.selector);
        _settle("late", late);
    }

    function test_revoke_onlyOwnerOrAgent() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        vm.prank(providerX);
        vm.expectRevert(ClearingHub.NotAuthorized.selector);
        hub.revokeMandate(id);
        vm.prank(agentA);
        hub.revokeMandate(id);
        vm.prank(owner);
        vm.expectRevert(ClearingHub.AlreadyRevoked.selector);
        hub.revokeMandate(id);
    }

    function test_settle_rejectsDuplicateBatchAndTokenMismatch() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        _settle("dup", _one(_claim(agentAKey, id, providerX, 1e6)));
        ClearingHub.Claim[] memory again = _one(_claim(agentAKey, id, providerX, 2e6));
        vm.expectRevert(ClearingHub.BatchExists.selector);
        _settle("dup", again);

        ClearingHub.Claim[] memory claims = _one(_claim(agentAKey, id, providerX, 2e6));
        vm.expectRevert(ClearingHub.TokenMismatch.selector);
        hub.settleBatch("other", bytes32(0), address(0xBEEF), claims);
    }

    function test_settle_afterExpiryGraceFails() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        vm.warp(block.timestamp + 1 days + 3 days + 1);
        ClearingHub.Claim[] memory expired = _one(_claim(agentAKey, id, providerX, 1e6));
        vm.expectRevert(ClearingHub.MandateNotActive.selector);
        _settle("expired", expired);
    }

    function test_verifyReceipt() public {
        bytes32 id = _open(_mandate(agentA, 10e6, bytes32(0)));
        bytes32 leafA = keccak256("receipt-a");
        bytes32 leafB = keccak256("receipt-b");
        bytes32 root = leafA < leafB ? keccak256(abi.encode(leafA, leafB)) : keccak256(abi.encode(leafB, leafA));
        hub.settleBatch("r", root, address(usdc), _one(_claim(agentAKey, id, providerX, 1e6)));
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = leafB;
        assertTrue(hub.verifyReceipt("r", leafA, proof));
        assertFalse(hub.verifyReceipt("r", keccak256("forged"), proof));
        assertFalse(hub.verifyReceipt("unknown", leafA, proof));
    }

    /// Netting must conserve value: every wallet ends exactly at its gross position, and the hub holds nothing.
    function testFuzz_nettingConservesValue(uint32[6] memory amounts) public {
        bytes32 idA = _open(_mandate(agentA, 1_000e6, bytes32(0)));
        bytes32 idB = _open(_mandate(agentB, 1_000e6, bytes32(0)));
        address[3] memory payees = [providerX, providerY, agentB];
        ClearingHub.Claim[] memory claims = new ClearingHub.Claim[](6);
        int256 dA;
        int256 dB;
        int256 dX;
        int256 dY;
        for (uint256 i; i < 6; ++i) {
            uint256 amt = uint256(amounts[i]) % 50e6 + 1;
            bool fromA = i < 3;
            address payee = fromA ? payees[i] : (i == 3 ? providerX : (i == 4 ? providerY : agentA));
            claims[i] = _claim(fromA ? agentAKey : agentBKey, fromA ? idA : idB, payee, amt);
            if (fromA) dA -= amt.toInt256();
            else dB -= amt.toInt256();
            if (payee == providerX) dX += amt.toInt256();
            else if (payee == providerY) dY += amt.toInt256();
            else if (payee == agentB) dB += amt.toInt256();
            else dA += amt.toInt256();
        }
        uint256 transfers = _settle("fuzz", claims);
        assertLe(transfers, 3, "four parties net in at most three transfers");
        assertEq(usdc.balanceOf(agentA).toInt256(), uint256(1_000e6).toInt256() + dA);
        assertEq(usdc.balanceOf(agentB).toInt256(), uint256(1_000e6).toInt256() + dB);
        assertEq(usdc.balanceOf(providerX).toInt256(), dX);
        assertEq(usdc.balanceOf(providerY).toInt256(), dY);
        assertEq(usdc.balanceOf(address(hub)), 0);
    }
}
