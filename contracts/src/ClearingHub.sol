// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title Payminto Clearing Hub
/// @notice Non-custodial clearing for agent-to-agent payments on HashKey Chain.
/// An owner signs a Mandate that gives an agent wallet a bounded budget.
/// The agent pays per call with gas-free cumulative Vouchers.
/// Anyone may settle a batch of Vouchers: the hub verifies every signature and cap,
/// nets all obligations, and moves only the net amounts directly between wallets.
/// The hub never holds funds.
contract ClearingHub is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice Settlement stays open this long after a revoke, so providers can claim calls already served.
    uint64 public constant REVOKE_GRACE = 1 hours;
    /// @notice Settlement stays open this long after a mandate expires, for the same reason.
    uint64 public constant EXPIRY_GRACE = 3 days;
    /// @notice Upper bound that keeps the in-memory netting loop within block gas.
    uint256 public constant MAX_CLAIMS = 64;

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address owner,address agent,address token,uint256 totalCap,uint64 validAfter,uint64 validUntil,bytes32 payeesRoot,bytes32 policyHash,bytes32 salt)"
    );
    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(bytes32 mandateId,address payee,uint256 cumulative)");

    struct Mandate {
        address owner;
        address agent;
        address token;
        uint256 totalCap;
        uint64 validAfter;
        uint64 validUntil;
        bytes32 payeesRoot; // OpenZeppelin StandardMerkleTree root over [address]; zero allows any payee
        bytes32 policyHash; // commitment to the off-chain policy (per-call and daily caps) the node enforces
        bytes32 salt;
    }

    struct MandateState {
        address owner;
        address agent;
        address token;
        uint64 validAfter;
        uint64 validUntil;
        uint64 revokedAt;
        uint256 totalCap;
        uint256 spent;
        bytes32 payeesRoot;
    }

    struct Voucher {
        bytes32 mandateId;
        address payee;
        uint256 cumulative;
    }

    struct Claim {
        Voucher voucher;
        bytes agentSig;
        bytes32[] payeeProof;
    }

    struct Batch {
        bytes32 receiptsRoot;
        address token;
        address settler;
        uint64 settledAt;
        uint128 gross;
        uint128 net;
    }

    mapping(bytes32 mandateId => MandateState) public mandates;
    mapping(bytes32 mandateId => mapping(address payee => uint256)) public settled;
    mapping(bytes32 batchId => Batch) public batches;

    event MandateOpened(
        bytes32 indexed mandateId,
        address indexed owner,
        address indexed agent,
        address token,
        uint256 totalCap,
        uint64 validUntil,
        bytes32 policyHash
    );
    event MandateRevoked(bytes32 indexed mandateId, address indexed by, uint64 settleUntil);
    event VoucherSettled(bytes32 indexed batchId, bytes32 indexed mandateId, address indexed payee, uint256 delta);
    event NetTransfer(bytes32 indexed batchId, address indexed from, address indexed to, uint256 amount);
    event BatchSettled(
        bytes32 indexed batchId,
        bytes32 receiptsRoot,
        address token,
        uint256 claims,
        uint256 gross,
        uint256 net,
        uint256 transfers
    );

    error InvalidMandate();
    error BadOwnerSignature();
    error BadAgentSignature();
    error MandateExists();
    error UnknownMandate();
    error NotAuthorized();
    error AlreadyRevoked();
    error MandateNotActive();
    error PayeeNotAllowed();
    error CapExceeded();
    error TokenMismatch();
    error BatchExists();
    error EmptyBatch();
    error TooManyClaims();
    error StaleVoucher();
    error NothingToSettle();
    error PermitFailed();

    constructor() EIP712("Payminto Clearing", "1") {}

    // ---------------------------------------------------------------------
    // Mandates
    // ---------------------------------------------------------------------

    /// @notice Registers an owner-signed mandate. Anyone may submit it; the signature is the authority.
    /// @dev Supports EOA and ERC-1271 owners (for example a Safe).
    function openMandate(Mandate calldata m, bytes calldata ownerSig) external returns (bytes32 mandateId) {
        return _openMandate(m, ownerSig);
    }

    /// @notice Opens a mandate and, in the same transaction, sets the agent's allowance to this hub with an
    /// EIP-2612 permit the agent signed off chain. The agent needs no native token and sends no transaction.
    /// @dev Front-run safe: anyone can submit a permit signature they observe, which consumes its nonce and makes
    /// our permit call revert. The allowance it set is what matters, so a failed permit is accepted when the
    /// allowance already covers permitValue; otherwise the whole call reverts and the mandate stays unopened.
    function openMandateWithPermit(
        Mandate calldata m,
        bytes calldata ownerSig,
        uint256 permitValue,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 mandateId) {
        mandateId = _openMandate(m, ownerSig);
        try IERC20Permit(m.token).permit(m.agent, address(this), permitValue, permitDeadline, v, r, s) {}
        catch {
            if (IERC20(m.token).allowance(m.agent, address(this)) < permitValue) revert PermitFailed();
        }
    }

    function _openMandate(Mandate calldata m, bytes calldata ownerSig) private returns (bytes32 mandateId) {
        if (m.owner == address(0) || m.agent == address(0) || m.token == address(0)) revert InvalidMandate();
        if (m.totalCap == 0 || m.validUntil <= m.validAfter || m.validUntil <= block.timestamp) {
            revert InvalidMandate();
        }
        // Keeps validUntil + EXPIRY_GRACE representable, otherwise settleDeadline would overflow and lock vouchers.
        if (m.validUntil > type(uint64).max - EXPIRY_GRACE) revert InvalidMandate();
        mandateId = mandateDigest(m);
        if (mandates[mandateId].owner != address(0)) revert MandateExists();
        if (!SignatureChecker.isValidSignatureNow(m.owner, mandateId, ownerSig)) revert BadOwnerSignature();

        mandates[mandateId] = MandateState({
            owner: m.owner,
            agent: m.agent,
            token: m.token,
            validAfter: m.validAfter,
            validUntil: m.validUntil,
            revokedAt: 0,
            totalCap: m.totalCap,
            spent: 0,
            payeesRoot: m.payeesRoot
        });
        emit MandateOpened(mandateId, m.owner, m.agent, m.token, m.totalCap, m.validUntil, m.policyHash);
    }

    /// @notice Stops a mandate. Vouchers already issued stay settleable for REVOKE_GRACE.
    function revokeMandate(bytes32 mandateId) external {
        MandateState storage s = mandates[mandateId];
        if (s.owner == address(0)) revert UnknownMandate();
        if (msg.sender != s.owner && msg.sender != s.agent) revert NotAuthorized();
        if (s.revokedAt != 0) revert AlreadyRevoked();
        s.revokedAt = uint64(block.timestamp);
        emit MandateRevoked(mandateId, msg.sender, uint64(block.timestamp) + REVOKE_GRACE);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice Verifies vouchers, nets every obligation in the batch and pays only net amounts.
    /// @param batchId Unique id chosen by the settler; HSP mandates bind to it via settlementBinding.
    /// @param receiptsRoot Merkle root over every per-call receipt the batch clears, for audit proofs.
    /// It is stored with msg.sender as settler; it proves nothing unless the settler is a trusted node.
    /// @param token The single ERC-20 every claim in the batch must use.
    function settleBatch(bytes32 batchId, bytes32 receiptsRoot, address token, Claim[] calldata claims)
        external
        nonReentrant
        returns (uint256 transfers)
    {
        uint256 n = claims.length;
        if (n == 0) revert EmptyBatch();
        if (n > MAX_CLAIMS) revert TooManyClaims();
        if (batches[batchId].settledAt != 0) revert BatchExists();

        // Every claim touches at most two parties, so 2n slots is enough.
        address[] memory parties = new address[](2 * n);
        int256[] memory balances = new int256[](2 * n);
        uint256 partyCount;
        uint256 gross;

        for (uint256 i; i < n; ++i) {
            uint256 delta = _applyClaim(batchId, token, claims[i]);
            if (delta == 0) continue;
            gross += delta;
            address agent = mandates[claims[i].voucher.mandateId].agent;
            partyCount = _credit(parties, balances, partyCount, agent, -delta.toInt256());
            partyCount = _credit(parties, balances, partyCount, claims[i].voucher.payee, delta.toInt256());
        }
        // A batch that moves nothing must not exist: otherwise anyone could replay settled vouchers
        // to anchor an arbitrary receiptsRoot that verifyReceipt would then accept.
        if (gross == 0) revert NothingToSettle();

        uint256 net;
        (transfers, net) = _payNet(batchId, IERC20(token), parties, balances, partyCount);

        batches[batchId] = Batch({
            receiptsRoot: receiptsRoot,
            token: token,
            settler: msg.sender,
            settledAt: uint64(block.timestamp),
            gross: gross.toUint128(),
            net: net.toUint128()
        });
        emit BatchSettled(batchId, receiptsRoot, token, n, gross, net, transfers);
    }

    /// @notice Proves that a leaf is in the receiptsRoot of a settled batch.
    /// @dev settleBatch is permissionless, so the root is only as trustworthy as batches[batchId].settler.
    /// A verifier must also check that the settler is the clearing node it trusts and that the node signed the leaf.
    function verifyReceipt(bytes32 batchId, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = batches[batchId].receiptsRoot;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function mandateDigest(Mandate calldata m) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    MANDATE_TYPEHASH,
                    m.owner,
                    m.agent,
                    m.token,
                    m.totalCap,
                    m.validAfter,
                    m.validUntil,
                    m.payeesRoot,
                    m.policyHash,
                    m.salt
                )
            )
        );
    }

    function voucherDigest(Voucher calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, v.mandateId, v.payee, v.cumulative)));
    }

    /// @notice Latest moment a voucher under this mandate can still be settled.
    function settleDeadline(bytes32 mandateId) public view returns (uint64) {
        MandateState storage s = mandates[mandateId];
        uint64 byExpiry = s.validUntil + EXPIRY_GRACE;
        if (s.revokedAt == 0) return byExpiry;
        uint64 byRevoke = s.revokedAt + REVOKE_GRACE;
        return byRevoke < byExpiry ? byRevoke : byExpiry;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _applyClaim(bytes32 batchId, address token, Claim calldata c) private returns (uint256 delta) {
        Voucher calldata v = c.voucher;
        MandateState storage s = mandates[v.mandateId];
        if (s.owner == address(0)) revert UnknownMandate();
        if (s.token != token) revert TokenMismatch();
        if (block.timestamp < s.validAfter || block.timestamp > settleDeadline(v.mandateId)) {
            revert MandateNotActive();
        }
        if (s.payeesRoot != bytes32(0)) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(v.payee))));
            if (!MerkleProof.verifyCalldata(c.payeeProof, s.payeesRoot, leaf)) revert PayeeNotAllowed();
        }
        if (!SignatureChecker.isValidSignatureNow(s.agent, voucherDigest(v), c.agentSig)) {
            revert BadAgentSignature();
        }

        uint256 already = settled[v.mandateId][v.payee];
        if (v.cumulative < already) revert StaleVoucher();
        delta = v.cumulative - already;
        if (delta == 0) return 0;
        if (s.spent + delta > s.totalCap) revert CapExceeded();

        settled[v.mandateId][v.payee] = v.cumulative;
        s.spent += delta;
        emit VoucherSettled(batchId, v.mandateId, v.payee, delta);
    }

    function _credit(address[] memory parties, int256[] memory balances, uint256 count, address who, int256 amount)
        private
        pure
        returns (uint256)
    {
        for (uint256 i; i < count; ++i) {
            if (parties[i] == who) {
                balances[i] += amount;
                return count;
            }
        }
        parties[count] = who;
        balances[count] = amount;
        return count + 1;
    }

    /// @dev Greedy two-pointer match of debtors to creditors. Produces at most (parties - 1) transfers,
    /// each a direct wallet-to-wallet transferFrom, so funds never rest in the hub.
    function _payNet(bytes32 batchId, IERC20 token, address[] memory parties, int256[] memory balances, uint256 count)
        private
        returns (uint256 transfers, uint256 net)
    {
        uint256 d;
        uint256 c;
        while (true) {
            while (d < count && balances[d] >= 0) ++d;
            while (c < count && balances[c] <= 0) ++c;
            if (d == count || c == count) break;

            uint256 owed = uint256(-balances[d]);
            uint256 due = uint256(balances[c]);
            uint256 amount = owed < due ? owed : due;

            token.safeTransferFrom(parties[d], parties[c], amount);
            emit NetTransfer(batchId, parties[d], parties[c], amount);

            balances[d] += amount.toInt256();
            balances[c] -= amount.toInt256();
            net += amount;
            ++transfers;
        }
    }
}
