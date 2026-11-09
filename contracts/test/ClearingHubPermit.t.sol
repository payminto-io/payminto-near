// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClearingHub} from "../src/ClearingHub.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

/// Gasless agent onboarding: openMandateWithPermit opens the mandate and sets the agent's allowance in one call
/// that the node (or anyone) submits, so the agent holds no native token and sends no transaction.
contract ClearingHubPermitTest is Test {
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    ClearingHub hub;
    MockStablecoin usdc;

    uint256 ownerKey = 0xA11CE;
    uint256 agentKey = 0xA6E17A;
    address owner;
    address agent;
    address relayer = makeAddr("relayer");
    address provider = makeAddr("provider");

    function setUp() public {
        vm.warp(1_800_000_000);
        hub = new ClearingHub();
        usdc = new MockStablecoin();
        owner = vm.addr(ownerKey);
        agent = vm.addr(agentKey);
        usdc.mint(agent, 100e6);
    }

    function _mandate(bytes32 salt) internal view returns (ClearingHub.Mandate memory) {
        return ClearingHub.Mandate({
            owner: owner,
            agent: agent,
            token: address(usdc),
            totalCap: 10e6,
            validAfter: uint64(block.timestamp - 1),
            validUntil: uint64(block.timestamp + 1 days),
            payeesRoot: bytes32(0),
            policyHash: keccak256("perCall=0.05;daily=5"),
            salt: salt
        });
    }

    function _ownerSig(ClearingHub.Mandate memory m) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, hub.mandateDigest(m));
        return abi.encodePacked(r, s, v);
    }

    function _permit(uint256 key, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address holder = vm.addr(key);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, holder, address(hub), value, usdc.nonces(holder), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(key, digest);
    }

    function test_openMandateWithPermit_opensAndApprovesWithoutAgentTransactions() public {
        ClearingHub.Mandate memory m = _mandate("a");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(agentKey, 10e6, deadline);
        uint256 agentNonceBefore = vm.getNonce(agent);

        vm.prank(relayer);
        bytes32 id = hub.openMandateWithPermit(m, _ownerSig(m), 10e6, deadline, v, r, s);

        assertEq(id, hub.mandateDigest(m));
        (address o, address a,,,,,,,) = hub.mandates(id);
        assertEq(o, owner);
        assertEq(a, agent);
        assertEq(usdc.allowance(agent, address(hub)), 10e6);
        assertEq(usdc.nonces(agent), 1);
        assertEq(vm.getNonce(agent), agentNonceBefore, "agent sent no transaction");
        assertEq(agent.balance, 0, "agent holds no native token");

        // The allowance is immediately usable for settlement.
        ClearingHub.Claim[] memory claims = new ClearingHub.Claim[](1);
        claims[0].voucher = ClearingHub.Voucher({mandateId: id, payee: provider, cumulative: 3e6});
        (v, r, s) = vm.sign(agentKey, hub.voucherDigest(claims[0].voucher));
        claims[0].agentSig = abi.encodePacked(r, s, v);
        hub.settleBatch(keccak256("b1"), keccak256("root"), address(usdc), claims);
        assertEq(usdc.balanceOf(provider), 3e6);
    }

    function test_openMandateWithPermit_frontRunPermitStillOpens() public {
        ClearingHub.Mandate memory m = _mandate("b");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(agentKey, 10e6, deadline);

        // An observer submits the permit first: it consumes the nonce, so the hub's own permit call reverts.
        vm.prank(makeAddr("frontRunner"));
        usdc.permit(agent, address(hub), 10e6, deadline, v, r, s);

        vm.prank(relayer);
        bytes32 id = hub.openMandateWithPermit(m, _ownerSig(m), 10e6, deadline, v, r, s);
        (address o,,,,,,,,) = hub.mandates(id);
        assertEq(o, owner, "mandate opened despite the front-run");
        assertEq(usdc.allowance(agent, address(hub)), 10e6);
    }

    function test_openMandateWithPermit_revertsWhenPermitFailsAndAllowanceIsShort() public {
        ClearingHub.Mandate memory m = _mandate("c");
        uint256 deadline = block.timestamp + 1 hours;
        // Signed by the wrong key: the permit reverts and no allowance exists.
        (uint8 v, bytes32 r, bytes32 s) = _permit(0xBAD, 10e6, deadline);
        bytes memory sig = _ownerSig(m);
        vm.expectRevert(ClearingHub.PermitFailed.selector);
        hub.openMandateWithPermit(m, sig, 10e6, deadline, v, r, s);
        (address o,,,,,,,,) = hub.mandates(hub.mandateDigest(m));
        assertEq(o, address(0), "the mandate is not opened");

        // An allowance below permitValue is not enough either.
        vm.prank(agent);
        usdc.approve(address(hub), 5e6);
        vm.expectRevert(ClearingHub.PermitFailed.selector);
        hub.openMandateWithPermit(m, sig, 10e6, deadline, v, r, s);
    }

    function test_openMandateWithPermit_expiredPermitWithExistingAllowanceOpens() public {
        ClearingHub.Mandate memory m = _mandate("d");
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _permit(agentKey, 10e6, deadline);
        vm.prank(agent);
        usdc.approve(address(hub), 10e6);
        bytes32 id = hub.openMandateWithPermit(m, _ownerSig(m), 10e6, deadline, v, r, s);
        (address o,,,,,,,,) = hub.mandates(id);
        assertEq(o, owner);
    }

    function test_openMandateWithPermit_stillChecksTheOwnerSignature() public {
        ClearingHub.Mandate memory m = _mandate("e");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(agentKey, 10e6, deadline);
        (uint8 ov, bytes32 or_, bytes32 os) = vm.sign(0xBAD, hub.mandateDigest(m));
        vm.expectRevert(ClearingHub.BadOwnerSignature.selector);
        hub.openMandateWithPermit(m, abi.encodePacked(or_, os, ov), 10e6, deadline, v, r, s);
        // Nothing happened, so the permit was not consumed.
        assertEq(usdc.nonces(agent), 0);
    }

    function test_openMandateWithPermit_tokenWithoutPermitNeedsAllowance() public {
        NoPermitToken plain = new NoPermitToken();
        ClearingHub.Mandate memory m = _mandate("f");
        m.token = address(plain);
        bytes memory sig = _ownerSig(m);
        vm.expectRevert(ClearingHub.PermitFailed.selector);
        hub.openMandateWithPermit(m, sig, 1, block.timestamp, 27, bytes32(0), bytes32(0));
        plain.setAllowance(agent, address(hub), 1);
        hub.openMandateWithPermit(m, sig, 1, block.timestamp, 27, bytes32(0), bytes32(0));
    }
}

/// A token without permit(): the call reverts, so only an existing allowance lets the mandate open.
contract NoPermitToken {
    mapping(address => mapping(address => uint256)) public allowance;

    function setAllowance(address o, address s, uint256 v) external {
        allowance[o][s] = v;
    }
}
