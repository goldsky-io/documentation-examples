// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReserveAggregator
 * @notice AggregatorV3Interface-compatible on-chain reserve / NAV publisher.
 * @dev A single authorized publisher (the Compose managed wallet) writes structured
 * NAV bundles. Existing Chainlink consumers can read `latestRoundData()` unchanged,
 * treating this feed as the fund's NAV/USD price.
 *
 * This is a demo contract. `getRoundData()` only returns data for the latest round —
 * historical rounds are not stored. Replace with a round-indexed mapping if you need
 * history.
 */
contract ReserveAggregator {
    // ============ Structs ============

    struct NavBundle {
        uint256 cash;
        uint256 tbills;
        uint256 repo;
        uint256 totalNav;
        uint64  asOf;       // custodian-side valuation timestamp
        uint64  updatedAt;  // block.timestamp at on-chain write
        uint80  roundId;
    }

    // ============ State ============

    /// @notice The Compose wallet authorized to publish NAV updates.
    address public publisher;

    /// @notice Human-readable feed description (set in constructor).
    string public feedDescription;

    /// @notice The latest published bundle.
    NavBundle private _latest;

    // ============ Events ============

    /// @notice Emitted on every successful publish.
    event NavUpdated(
        uint80  indexed roundId,
        uint256 totalNav,
        uint256 cash,
        uint256 tbills,
        uint256 repo,
        uint64  asOf
    );

    /// @notice Emitted when the publisher address is rotated.
    event PublisherRotated(address indexed previousPublisher, address indexed newPublisher);

    // ============ Errors ============

    error OnlyPublisher();
    error NoDataYet();
    error NoHistoricalData(uint80 requestedRound, uint80 latestRound);
    error ZeroAddress();
    error NavOverflowsInt256(uint256 totalNav);

    // ============ Constructor ============

    /// @param _publisher The Compose managed wallet authorized to call updateNav.
    /// @param _description A short label for this feed (e.g. "Example RWA Fund I NAV / USD").
    constructor(address _publisher, string memory _description) {
        if (_publisher == address(0)) revert ZeroAddress();
        publisher = _publisher;
        feedDescription = _description;
    }

    // ============ External: Writer ============

    /**
     * @notice Publish a new NAV bundle. Callable only by the configured publisher.
     * @param cash      Cash-equivalent holdings, scaled to 18 decimals.
     * @param tbills    T-bill holdings, scaled to 18 decimals.
     * @param repo      Repo / other holdings, scaled to 18 decimals.
     * @param totalNav  Total NAV (scalar consumers read this), scaled to 18 decimals.
     * @param asOf      Unix seconds — the custodian's "as of" timestamp for this bundle.
     */
    function updateNav(
        uint256 cash,
        uint256 tbills,
        uint256 repo,
        uint256 totalNav,
        uint64  asOf
    ) external {
        if (msg.sender != publisher) revert OnlyPublisher();
        // AggregatorV3Interface returns int256; guard so latestRoundData
        // can never expose a wrapped negative answer for absurd uint values.
        if (totalNav > uint256(type(int256).max)) revert NavOverflowsInt256(totalNav);

        uint80 nextRound = _latest.roundId + 1;

        _latest = NavBundle({
            cash:      cash,
            tbills:    tbills,
            repo:      repo,
            totalNav:  totalNav,
            asOf:      asOf,
            updatedAt: uint64(block.timestamp),
            roundId:   nextRound
        });

        emit NavUpdated(nextRound, totalNav, cash, tbills, repo, asOf);
    }

    /**
     * @notice Rotate the publisher (e.g. after moving to a new Compose wallet).
     * @dev Only the current publisher may rotate.
     */
    function setPublisher(address newPublisher) external {
        if (msg.sender != publisher) revert OnlyPublisher();
        // Rotating to address(0) would brick the contract (msg.sender can never
        // equal address(0)), so reject explicitly. There is no recovery path
        // from a misset publisher otherwise.
        if (newPublisher == address(0)) revert ZeroAddress();
        emit PublisherRotated(publisher, newPublisher);
        publisher = newPublisher;
    }

    // ============ External: AggregatorV3Interface reads ============

    /// @notice Fixed at 18 to match Chainlink conventions for USD-denominated feeds.
    function decimals() external pure returns (uint8) {
        return 18;
    }

    function description() external view returns (string memory) {
        return feedDescription;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        if (_latest.roundId == 0) revert NoDataYet();
        return (
            _latest.roundId,
            int256(_latest.totalNav),
            uint256(_latest.asOf),       // startedAt = custodian valuation timestamp
            uint256(_latest.updatedAt),  // updatedAt = on-chain write block timestamp (matches Chainlink staleness semantics)
            _latest.roundId
        );
    }

    /**
     * @notice Demo simplification: only the latest round is retained.
     * Calls for any other roundId revert with NoHistoricalData.
     */
    function getRoundData(uint80 _roundId)
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        )
    {
        if (_latest.roundId == 0) revert NoDataYet();
        if (_roundId != _latest.roundId) {
            revert NoHistoricalData(_roundId, _latest.roundId);
        }
        return (
            _latest.roundId,
            int256(_latest.totalNav),
            uint256(_latest.asOf),
            uint256(_latest.updatedAt),
            _latest.roundId
        );
    }

    // ============ External: Richer reads ============

    /// @notice Return the full structured bundle for the latest round.
    function latestBundle() external view returns (NavBundle memory) {
        if (_latest.roundId == 0) revert NoDataYet();
        return _latest;
    }
}
