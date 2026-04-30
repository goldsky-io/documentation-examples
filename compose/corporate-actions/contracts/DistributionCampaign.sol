// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title DistributionCampaign
 * @notice On-chain audit-trail + double-pay guard for tokenized corporate-action distributions
 *         (dividends, coupons, rebates, rewards). Operator-supplied per-holder amounts; the
 *         contract enforces escrow caps and one-time payment per holder.
 *
 * @dev Many campaigns can coexist in a single deployed instance; each is keyed by a canonical
 *      `id = keccak256(operator, userId)` to namespace user-supplied IDs across operators.
 *
 *      Reverts use string `require` messages (not custom errors) so off-chain callers can
 *      decode them via the standard `Error(string)` selector.
 *
 *      Demo-grade. Not audited. Anyone can `declare()` a campaign with their own funds; the
 *      operator address is recorded and only the operator can `pay()` or `seal()` that campaign.
 */
contract DistributionCampaign {
    struct Campaign {
        address operator;        // wallet that called declare(); only caller for pay/seal
        address payToken;        // ERC-20 used for payouts (e.g. MockUSDC)
        address shareToken;      // tokenized equity reference (informational; for audit reconciliation)
        uint256 totalAmount;     // initial escrow pulled from operator at declare time
        uint256 escrowRemaining; // decremented per pay(); refunded on seal()
        uint256 recordBlock;     // snapshot block at declare time (audit reference)
        bool    declared;        // set on declare; prevents re-declare under same id
        bool    sealed_;         // terminal; no more pay() allowed
    }

    /// @notice campaigns[canonicalId]
    mapping(bytes32 => Campaign) public campaigns;

    /// @notice paid[canonicalId][holder] = amount (0 means unpaid)
    mapping(bytes32 => mapping(address => uint256)) public paid;

    event CampaignDeclared(
        bytes32 indexed id,
        address indexed operator,
        address payToken,
        address shareToken,
        uint256 totalAmount,
        uint256 recordBlock
    );
    event HolderPaid(
        bytes32 indexed id,
        address indexed holder,
        address payToken,         // included so auditors don't need a separate getCampaign call
        uint256 amount,
        uint256 sharesAtSnapshot  // operator-supplied; lets auditors recompute pro-rata independently
    );
    event CampaignSealed(bytes32 indexed id, uint256 refunded);

    /// @notice Derive canonical id from operator + user-supplied id. Anyone can call this view to
    ///         compute the id off-chain before tx submission.
    function canonicalId(address operator, bytes32 userId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(operator, userId));
    }

    /// @notice Open a new campaign. Pulls `totalAmount` of `payToken` from msg.sender atomically.
    ///         The record block is `block.number` of the declare tx — the off-chain indexer
    ///         must wait for that block + finality depth before reading the snapshot.
    /// @param userId      operator-supplied identifier; canonical id = keccak256(operator, userId)
    /// @param payToken    ERC-20 used for payouts
    /// @param shareToken  reference share token (informational; recorded in events)
    /// @param totalAmount total escrow to pull from msg.sender via transferFrom
    /// @return id         canonical id
    function declare(
        bytes32 userId,
        address payToken,
        address shareToken,
        uint256 totalAmount
    ) external returns (bytes32 id) {
        id = canonicalId(msg.sender, userId);
        Campaign storage c = campaigns[id];
        require(!c.declared, "AlreadyDeclared");
        require(totalAmount > 0, "ZeroAmount");

        c.operator = msg.sender;
        c.payToken = payToken;
        c.shareToken = shareToken;
        c.totalAmount = totalAmount;
        c.escrowRemaining = totalAmount;
        c.recordBlock = block.number;
        c.declared = true;

        require(IERC20(payToken).transferFrom(msg.sender, address(this), totalAmount), "TransferFromFailed");

        emit CampaignDeclared(id, msg.sender, payToken, shareToken, totalAmount, block.number);
    }

    /// @notice Pay one holder for one campaign. Idempotent — reverts `AlreadyPaid` on duplicate.
    /// @dev Strict checks-effects-interactions: paid[] and escrowRemaining are updated BEFORE the
    ///      external transfer to defeat any reentrancy hook in a swapped-in pay token.
    function pay(
        bytes32 id,
        address holder,
        uint256 amount,
        uint256 sharesAtSnapshot
    ) external {
        Campaign storage c = campaigns[id];
        require(c.declared, "NotDeclared");
        require(!c.sealed_, "AlreadySealed");
        require(msg.sender == c.operator, "NotOperator");
        require(paid[id][holder] == 0, "AlreadyPaid");
        require(c.escrowRemaining >= amount, "InsufficientEscrow");
        require(amount > 0, "ZeroAmount");

        // Effects
        paid[id][holder] = amount;
        c.escrowRemaining -= amount;

        // Interaction
        require(IERC20(c.payToken).transfer(holder, amount), "TransferFailed");

        emit HolderPaid(id, holder, c.payToken, amount, sharesAtSnapshot);
    }

    /// @notice Close out a campaign and return any unpaid escrow to the operator.
    function seal(bytes32 id) external {
        Campaign storage c = campaigns[id];
        require(c.declared, "NotDeclared");
        require(!c.sealed_, "AlreadySealed");
        require(msg.sender == c.operator, "NotOperator");

        uint256 refund = c.escrowRemaining;
        c.escrowRemaining = 0;
        c.sealed_ = true;

        if (refund > 0) {
            require(IERC20(c.payToken).transfer(c.operator, refund), "TransferFailed");
        }
        emit CampaignSealed(id, refund);
    }

    /// @notice Read the full campaign struct.
    function getCampaign(bytes32 id) external view returns (Campaign memory) {
        return campaigns[id];
    }

    /// @notice True if `holder` has been paid for `id`.
    function isPaid(bytes32 id, address holder) external view returns (bool) {
        return paid[id][holder] != 0;
    }
}
