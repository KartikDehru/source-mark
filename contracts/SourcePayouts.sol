// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SourcePayouts
/// @notice Revenue routing and liability for the SourceMark read layer.
///
/// Every paid read is recorded here with the set of data sources that actually
/// answered it. Each source's cut is split into a portion that is immediately
/// withdrawable and a portion held back unvested for a fixed window.
///
/// The held-back portion is the liability pool. If a receipt is later shown to
/// be falsified, the buyer is refunded out of the unvested holdback of the
/// sources that contributed the false claim.
///
/// The design choice worth calling out: a source never posts collateral. It is
/// only ever at risk of losing revenue it has already earned but not yet
/// cleared. That makes participation costless to join and still expensive to
/// abuse, which is what lets the payee set grow without anyone's permission.
///
/// Deliberate constraints, so the guarantees are not overstated:
///   - The operator can withdraw the routing fee and nothing else. Source
///     balances are not reachable by the operator under any code path.
///   - Unclaimed source funds are never sweepable. There is no rescue function.
///   - Dispute resolution is arbiter-gated, not trustless. Anyone may OPEN a
///     dispute permissionlessly and every dispute is a public event, but a
///     named arbiter decides it. Making that decision trustless requires
///     onchain re-derivation of a subgraph query, which is out of scope here
///     and should not be claimed.
///   - An open dispute freezes vesting for the sources named on the receipt.
///     That is what stops a source from outlasting a challenge, and it is also
///     a griefing surface: the bond is the only thing making a frivolous
///     freeze expensive. Size the bond accordingly.
///   - Once a holdback vests, it is gone. The liability window is exactly
///     `vestingSeconds` from the read, and a dispute opened after it recovers
///     nothing.
contract SourcePayouts {
    // ─── Types ───────────────────────────────────────────────────────────────

    /// @dev One tranche of held-back revenue for a single source.
    struct Lot {
        uint128 amount;
        uint64 vestsAt;
    }

    struct Receipt {
        address buyer;
        uint128 gross;
        uint64 recordedAt;
        bool disputed;
        bytes32[] sources;
    }

    struct Dispute {
        address claimant;
        uint128 bond;
        uint64 openedAt;
        bool resolved;
        bool upheld;
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    address public immutable operator;
    address public arbiter;

    /// @dev The only address allowed to record reads. Separate from `operator`
    /// because this key lives in the running gateway and is therefore the most
    /// exposed one in the system. It can credit sources and nothing else: it
    /// cannot withdraw the fee, move the arbiter, or reach source balances.
    address public recorder;

    uint16 public immutable routingFeeBps;
    uint16 public immutable holdbackBps;
    uint64 public immutable vestingSeconds;
    uint128 public immutable disputeBond;

    uint256 public operatorBalance;

    /// @dev sourceId is keccak256 of the pinned deployment id string.
    mapping(bytes32 => address) public payoutAddressOf;
    mapping(bytes32 => uint256) public withdrawable;
    mapping(bytes32 => Lot[]) private _lots;
    mapping(bytes32 => uint256) private _lotCursor;

    mapping(bytes32 => Receipt) private _receipts;
    mapping(bytes32 => Dispute) private _disputes;

    /// @dev How many unresolved disputes a source is currently party to. While
    /// this is non-zero the source's holdback cannot vest. Without it a source
    /// could simply outlast a pending dispute: the arbiter's ruling would land
    /// after the vesting window and recover nothing.
    mapping(bytes32 => uint32) public openDisputeCount;

    // ─── Events ──────────────────────────────────────────────────────────────

    event SourceRegistered(bytes32 indexed sourceId, address indexed payoutAddress);
    event ReadRecorded(bytes32 indexed receiptDigest, address indexed buyer, uint256 gross, uint256 sourceCount);
    event Accrued(bytes32 indexed sourceId, uint256 vested, uint256 heldBack, uint64 vestsAt);
    event Claimed(bytes32 indexed sourceId, address indexed to, uint256 amount);
    event DisputeOpened(bytes32 indexed receiptDigest, address indexed claimant, string reason);
    event DisputeResolved(bytes32 indexed receiptDigest, bool upheld, uint256 refunded);
    event Slashed(bytes32 indexed sourceId, bytes32 indexed receiptDigest, uint256 amount);
    event OperatorWithdrew(uint256 amount);
    event ArbiterChanged(address indexed previous, address indexed next);
    event RecorderChanged(address indexed previous, address indexed next);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error NotOperator();
    error NotArbiter();
    error NotRecorder();
    error NoSources();
    error NoValue();
    error UnknownSource(bytes32 sourceId);
    error DuplicateReceipt(bytes32 receiptDigest);
    error UnknownReceipt(bytes32 receiptDigest);
    error AlreadyDisputed(bytes32 receiptDigest);
    error DisputeAlreadyResolved(bytes32 receiptDigest);
    error BadBond(uint256 sent, uint256 required);
    error NothingToClaim();
    error NotPayee();
    error TransferFailed();
    error BadParams();

    // ─── Construction ────────────────────────────────────────────────────────

    constructor(
        address arbiter_,
        uint16 routingFeeBps_,
        uint16 holdbackBps_,
        uint64 vestingSeconds_,
        uint128 disputeBond_
    ) {
        if (arbiter_ == address(0)) revert BadParams();
        if (uint256(routingFeeBps_) + uint256(holdbackBps_) > 10_000) revert BadParams();

        operator = msg.sender;
        arbiter = arbiter_;
        recorder = msg.sender;
        routingFeeBps = routingFeeBps_;
        holdbackBps = holdbackBps_;
        vestingSeconds = vestingSeconds_;
        disputeBond = disputeBond_;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier onlyRecorder() {
        if (msg.sender != recorder) revert NotRecorder();
        _;
    }

    // ─── Registration ────────────────────────────────────────────────────────

    /// @notice Point a source's earnings at an address. Opt-in by construction:
    /// a deployment that never registers simply accrues nothing.
    function registerSource(bytes32 sourceId, address payoutAddress) external onlyOperator {
        if (payoutAddress == address(0)) revert BadParams();
        payoutAddressOf[sourceId] = payoutAddress;
        emit SourceRegistered(sourceId, payoutAddress);
    }

    // ─── Recording a paid read ───────────────────────────────────────────────

    /// @notice Record a settled read and split its revenue across the sources
    /// that answered it. Called by the gateway with the settled amount attached.
    /// @dev Gated. Left open, anyone could pre-record the digest the gateway is
    /// about to use for one wei, making the real settlement revert as a
    /// duplicate — a cheap way to grief every read in the system.
    function recordRead(bytes32 receiptDigest, bytes32[] calldata sourceIds, address buyer)
        external
        payable
        onlyRecorder
    {
        if (msg.value == 0) revert NoValue();
        if (sourceIds.length == 0) revert NoSources();
        // A receipt with no buyer is a receipt whose refund burns. Reject it
        // here rather than discovering it when a dispute is upheld.
        if (buyer == address(0)) revert BadParams();
        if (_receipts[receiptDigest].recordedAt != 0) revert DuplicateReceipt(receiptDigest);

        uint256 fee = (msg.value * routingFeeBps) / 10_000;
        uint256 distributable = msg.value - fee;
        uint256 per = distributable / sourceIds.length;
        uint256 held = (per * holdbackBps) / 10_000;
        uint256 vested = per - held;
        uint64 vestsAt = uint64(block.timestamp) + vestingSeconds;

        for (uint256 i = 0; i < sourceIds.length; ++i) {
            bytes32 id = sourceIds[i];
            if (payoutAddressOf[id] == address(0)) revert UnknownSource(id);

            withdrawable[id] += vested;
            if (held != 0) _lots[id].push(Lot({amount: uint128(held), vestsAt: vestsAt}));

            emit Accrued(id, vested, held, vestsAt);
        }

        // Rounding dust stays with the operator rather than being silently lost.
        operatorBalance += fee + (distributable - per * sourceIds.length);

        _receipts[receiptDigest] = Receipt({
            buyer: buyer,
            gross: uint128(msg.value),
            recordedAt: uint64(block.timestamp),
            disputed: false,
            sources: sourceIds
        });

        emit ReadRecorded(receiptDigest, buyer, msg.value, sourceIds.length);
    }

    // ─── Claiming ────────────────────────────────────────────────────────────

    /// @notice Move every matured holdback lot into the withdrawable balance.
    /// Bounded by `maxLots` so a source with a long history can always claim.
    /// @dev Frozen while the source is party to an unresolved dispute, so the
    /// holdback that is under challenge stays reachable by the arbiter.
    function vest(bytes32 sourceId, uint256 maxLots) public returns (uint256 moved) {
        if (openDisputeCount[sourceId] != 0) return 0;

        Lot[] storage lots = _lots[sourceId];
        uint256 i = _lotCursor[sourceId];
        uint256 end = lots.length;
        uint256 processed;

        while (i < end && processed < maxLots) {
            Lot storage lot = lots[i];
            if (lot.vestsAt > block.timestamp) break;
            moved += lot.amount;
            unchecked {
                ++i;
                ++processed;
            }
        }

        _lotCursor[sourceId] = i;
        if (moved != 0) withdrawable[sourceId] += moved;
    }

    /// @notice Withdraw a source's cleared earnings to its registered address.
    /// Callable by that address only. There is no operator path to these funds.
    function claim(bytes32 sourceId) external {
        address to = payoutAddressOf[sourceId];
        if (to == address(0)) revert UnknownSource(sourceId);
        if (msg.sender != to) revert NotPayee();

        vest(sourceId, 256);

        uint256 amount = withdrawable[sourceId];
        if (amount == 0) revert NothingToClaim();
        withdrawable[sourceId] = 0;

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Claimed(sourceId, to, amount);
    }

    // ─── Disputes ────────────────────────────────────────────────────────────

    /// @notice Permissionlessly challenge a receipt. The bond makes spam costly
    /// and is returned if the dispute is upheld.
    function openDispute(bytes32 receiptDigest, string calldata reason) external payable {
        Receipt storage r = _receipts[receiptDigest];
        if (r.recordedAt == 0) revert UnknownReceipt(receiptDigest);
        if (r.disputed) revert AlreadyDisputed(receiptDigest);
        if (msg.value != disputeBond) revert BadBond(msg.value, disputeBond);

        r.disputed = true;
        _disputes[receiptDigest] = Dispute({
            claimant: msg.sender,
            bond: uint128(msg.value),
            openedAt: uint64(block.timestamp),
            resolved: false,
            upheld: false
        });

        // Freeze vesting for every source named on the receipt for as long as
        // the challenge is unresolved.
        for (uint256 i = 0; i < r.sources.length; ++i) {
            openDisputeCount[r.sources[i]] += 1;
        }

        emit DisputeOpened(receiptDigest, msg.sender, reason);
    }

    /// @notice Resolve a dispute. If upheld, every source on the receipt is
    /// slashed from its unvested holdback and the buyer is refunded.
    /// @dev Refunds are capped at what is actually unvested. We never promise a
    /// refund the contract cannot fund.
    function resolveDispute(bytes32 receiptDigest, bool upheld) external onlyArbiter {
        Dispute storage d = _disputes[receiptDigest];
        if (d.openedAt == 0) revert UnknownReceipt(receiptDigest);
        if (d.resolved) revert DisputeAlreadyResolved(receiptDigest);

        d.resolved = true;
        d.upheld = upheld;

        Receipt storage r = _receipts[receiptDigest];
        uint256 refund;

        if (upheld) {
            uint256 target = r.gross / r.sources.length;
            for (uint256 i = 0; i < r.sources.length; ++i) {
                // Maturity is judged as of when the dispute was opened, not
                // now. A lot that was still unvested when the challenge landed
                // stays at risk however long the arbiter takes to rule.
                refund += _slashUnvested(r.sources[i], receiptDigest, target, d.openedAt);
            }
        }

        // Unfreeze before paying out, so nothing re-enters into a frozen state.
        for (uint256 i = 0; i < r.sources.length; ++i) {
            openDisputeCount[r.sources[i]] -= 1;
        }

        if (upheld) {
            _send(r.buyer, refund);
            _send(d.claimant, d.bond);
        } else {
            operatorBalance += d.bond;
        }

        emit DisputeResolved(receiptDigest, upheld, refund);
    }

    /// @dev Burn down a source's unvested lots, newest first, up to `target`.
    /// Newest-first is intentional: the most recent revenue is the most likely
    /// to have come from the same faulty indexing run.
    function _slashUnvested(bytes32 sourceId, bytes32 receiptDigest, uint256 target, uint64 asOf)
        private
        returns (uint256 taken)
    {
        Lot[] storage lots = _lots[sourceId];
        uint256 cursor = _lotCursor[sourceId];

        for (uint256 i = lots.length; i > cursor && taken < target;) {
            unchecked {
                --i;
            }
            Lot storage lot = lots[i];
            if (lot.vestsAt <= asOf || lot.amount == 0) continue;

            uint256 want = target - taken;
            uint256 take = lot.amount <= want ? lot.amount : want;
            lot.amount -= uint128(take);
            taken += take;
        }

        if (taken != 0) emit Slashed(sourceId, receiptDigest, taken);
    }

    // ─── Operator ────────────────────────────────────────────────────────────

    function withdrawOperator() external onlyOperator {
        uint256 amount = operatorBalance;
        if (amount == 0) revert NothingToClaim();
        operatorBalance = 0;
        _send(operator, amount);
        emit OperatorWithdrew(amount);
    }

    function setArbiter(address next) external onlyOperator {
        if (next == address(0)) revert BadParams();
        emit ArbiterChanged(arbiter, next);
        arbiter = next;
    }

    /// @notice Rotate the gateway key allowed to record reads. Kept behind the
    /// operator so a compromised gateway can be cut off without redeploying.
    function setRecorder(address next) external onlyOperator {
        if (next == address(0)) revert BadParams();
        emit RecorderChanged(recorder, next);
        recorder = next;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice Holdback that has not yet matured, and so is at risk from a
    /// dispute opened right now.
    function unvestedHoldback(bytes32 sourceId) external view returns (uint256 total) {
        Lot[] storage lots = _lots[sourceId];
        for (uint256 i = _lotCursor[sourceId]; i < lots.length; ++i) {
            if (lots[i].vestsAt > block.timestamp) total += lots[i].amount;
        }
    }

    /// @notice Holdback the source has not moved into its withdrawable balance
    /// yet, whether or not it has matured.
    /// @dev Distinct from `unvestedHoldback` during a dispute freeze: those
    /// lots are past their vesting time but still held, and still reachable by
    /// the arbiter because slashing judges maturity as of the dispute.
    function unclearedHoldback(bytes32 sourceId) external view returns (uint256 total) {
        Lot[] storage lots = _lots[sourceId];
        for (uint256 i = _lotCursor[sourceId]; i < lots.length; ++i) {
            total += lots[i].amount;
        }
    }

    function claimable(bytes32 sourceId) external view returns (uint256 total) {
        total = withdrawable[sourceId];

        // Matured lots are unreachable while a dispute is pending, so they are
        // not claimable and should not be shown as such.
        if (openDisputeCount[sourceId] != 0) return total;

        Lot[] storage lots = _lots[sourceId];
        for (uint256 i = _lotCursor[sourceId]; i < lots.length; ++i) {
            if (lots[i].vestsAt <= block.timestamp) total += lots[i].amount;
            else break;
        }
    }

    function receiptOf(bytes32 receiptDigest) external view returns (Receipt memory) {
        return _receipts[receiptDigest];
    }

    function disputeOf(bytes32 receiptDigest) external view returns (Dispute memory) {
        return _disputes[receiptDigest];
    }

    function sourceIdFor(string calldata deploymentId) external pure returns (bytes32) {
        return keccak256(bytes(deploymentId));
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
